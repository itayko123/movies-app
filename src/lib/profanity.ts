/**
 * Bilingual (English + Hebrew) profanity filter for user-submitted reviews.
 *
 * ── What this is, and what it is NOT ───────────────────────────────────────
 * This is a UX guardrail: it stops someone posting something they will regret
 * and keeps casual abuse out of the review list. It is NOT a security control
 * and must never be treated as one. It runs on the client, so anyone willing
 * to open a network tab can bypass it completely. **Any real deployment needs
 * the same check server-side** (a Postgres trigger or an Edge Function on
 * insert) — the client copy exists so the user gets instant feedback rather
 * than a rejection after the round-trip.
 *
 * ── Matching strategy: whole tokens, not substrings ────────────────────────
 * Substring matching is the classic way to get this wrong — the Scunthorpe
 * problem. "class", "assess" and "grass" all contain a slur; "Scunthorpe" and
 * "Penistone" are real place names. A filter that blocks those is worse than no
 * filter, because it silently eats legitimate reviews and the author cannot
 * tell why.
 *
 * So the text is split into tokens and each token is compared WHOLE against the
 * dictionary. Both sides go through the same normaliser, which is what defeats
 * the obvious evasions without resorting to substrings.
 *
 * ── Hebrew specifics ───────────────────────────────────────────────────────
 * JavaScript's `\b` is defined against [A-Za-z0-9_], so every Hebrew letter
 * counts as a NON-word character and `\bמילה\b` can never match. That rules out
 * the usual word-boundary regex approach entirely, which is the second reason
 * this tokenises manually. Hebrew also writes five letters differently at the
 * end of a word (ך ם ן ף ץ), so those are folded to their standard forms before
 * comparison, and single-letter prefixes (ו/ה/ב/ל/כ/מ/ש) are stripped as a
 * fallback so "והמילה" still matches "מילה".
 */

/** Leetspeak and lookalike substitutions, applied before comparison. */
const SUBSTITUTIONS: Record<string, string> = {
  '4': 'a',
  '@': 'a',
  '8': 'b',
  '(': 'c',
  '3': 'e',
  '6': 'g',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '0': 'o',
  '5': 's',
  $: 's',
  '7': 't',
  '+': 't',
  '2': 'z',
};

/** Hebrew final forms → standard forms. */
const HEBREW_FINALS: Record<string, string> = {
  'ך': 'כ',
  'ם': 'מ',
  'ן': 'נ',
  'ף': 'פ',
  'ץ': 'צ',
};

/** Single-letter Hebrew prefixes that attach directly to a noun. */
const HEBREW_PREFIXES = 'והבלכמש';

/**
 * English terms.
 *
 * Deliberately covers vulgarity and slurs, not mild interjections — "damn" and
 * "hell" appear constantly in film reviews ("a hell of a performance") and
 * blocking them would make the feature feel broken.
 */
const ENGLISH = [
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch',
  'cunt', 'asshole', 'dickhead', 'bastard', 'wanker', 'twat', 'prick',
  'slut', 'whore', 'faggot', 'nigger', 'nigga', 'retard', 'retarded',
  'pussy', 'jerkoff', 'douchebag', 'skank',
  // NOTE: bare "dick" and "cock" are deliberately EXCLUDED.
  //
  // This is a film app. "Dick Van Dyke", "Moby Dick", "Dick Tracy" and
  // "Philip K. Dick" are all things a reviewer will legitimately type, and a
  // filter that silently rejects a review about Mary Poppins — giving no
  // usable reason — is worse than letting the mildest word in the list
  // through. Caught by the test suite on "Dick Van Dyke was great".
  // "dickhead" above is unambiguous and stays.
  //
  // If these must be blocked, the fix is a phrase allowlist, not adding the
  // bare token back.
];

/**
 * Hebrew terms.
 *
 * STARTER LIST — this needs review by a native speaker and by whoever owns
 * community policy before launch. Hebrew profanity leans heavily on borrowed
 * Arabic vulgarities and on multi-word constructions, and the register of an
 * individual term varies a lot by context; that judgement is not something to
 * hard-code from the outside.
 */
const HEBREW = [
  'זין', 'זיין', 'כוס', 'כוסית', 'שרמוטה', 'זונה', 'בן זונה', 'בת זונה',
  'מניאק', 'מטומטם', 'מפגר', 'חרא', 'תחת', 'לזיין', 'מזדיין', 'דפוק',
  'אידיוט', 'אחשרמוטה', 'כוסאמק', 'אמק', 'שרמוטות', 'זבל',
];

/** Multi-word phrases, checked against the normalised whole text. */
const PHRASES = ['בן זונה', 'בת זונה', 'son of a bitch', 'piece of shit'];

/**
 * Normalises one token for comparison.
 *
 * Applied to BOTH the input and the dictionary, so the two are always compared
 * in the same space. That symmetry is why collapsing repeats is safe: "pass"
 * and dictionary "ass" both collapse ("pas" / "as") and still do not match,
 * because tokens are compared whole.
 */
export function normaliseToken(token: string): string {
  let out = token.toLowerCase();

  // Leet → letters.
  out = [...out].map((char) => SUBSTITUTIONS[char] ?? char).join('');

  // Hebrew final forms → standard.
  out = [...out].map((char) => HEBREW_FINALS[char] ?? char).join('');

  // Keep only letters (Latin + Hebrew); drops punctuation used as padding.
  out = out.replace(/[^a-z֐-׿]/g, '');

  // Collapse runs: "fuuuuck" and "fuck" normalise identically.
  out = out.replace(/(.)\1+/g, '$1');

  return out;
}

function buildDictionary(words: string[]): Set<string> {
  const set = new Set<string>();
  for (const word of words) {
    const normalised = normaliseToken(word);
    if (normalised.length >= 2) set.add(normalised);
  }
  return set;
}

const BLOCKED = buildDictionary([...ENGLISH, ...HEBREW]);
const BLOCKED_PHRASES = PHRASES.map((phrase) =>
  phrase.split(/\s+/).map(normaliseToken).join(' '),
);

/** Splits on anything that is not a letter or digit, in either script. */
function tokenize(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Peels leading Hebrew prefix letters, returning each intermediate form.
 *
 * Prefixes STACK — "ו"+"ה" is "and the", "ש"+"ה" is "that the" — so stripping
 * only one missed "והשרמוטה". Two levels covers every common pairing. The
 * remainder is kept at >= 3 letters so peeling can never manufacture a short
 * false positive out of an ordinary word.
 */
function hebrewPrefixStrippings(token: string): string[] {
  const out: string[] = [];
  let current = token;
  for (let level = 0; level < 2; level++) {
    if (current.length < 4) break;
    const first = current[0]!;
    if (!HEBREW_PREFIXES.includes(first)) break;
    current = current.slice(1);
    out.push(current);
  }
  return out;
}

/**
 * Recovers letters spaced out to dodge tokenisation: "f.u.c.k", "ש ר מ ו ט ה".
 *
 * Deliberately narrow. It only fires on runs of THREE OR MORE consecutive
 * single letters each followed by a separator — a shape that essentially never
 * occurs in ordinary prose but is exactly what evasion looks like.
 *
 * The run is then tested as every contiguous WINDOW rather than only whole,
 * because the greedy match overshoots: on "f.u.c.k this" the regex happily
 * consumes "f.u.c.k t" (the trailing "k " is itself a valid letter+separator
 * repetition), which normalises to "fuckt" and matched nothing. Caught by the
 * test suite.
 *
 * Window matching is safe HERE, unlike on ordinary text, precisely because the
 * input already had to be a run of isolated single letters to get this far —
 * "class" and "Scunthorpe" can never reach this function.
 */
function spacedOutCandidates(text: string): string[] {
  const pattern = /(?:[\p{L}][^\p{L}\p{N}]+){2,}[\p{L}]/gu;
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const letters = normaliseToken(match[0]);
    for (let start = 0; start < letters.length; start++) {
      for (let end = start + 3; end <= letters.length; end++) {
        found.push(letters.slice(start, end));
      }
    }
  }
  return found;
}

/**
 * Substitution characters applied across the WHOLE text before tokenising.
 *
 * Necessary because tokenisation splits on non-letters, so "@sshole" lost its
 * "@" before it could ever become an "a" and the token became "sshole" — which
 * matched nothing. Running a second pass over pre-substituted text fixes that
 * without corrupting the primary pass, where "Wow!" would otherwise tokenise as
 * "wowi". Both passes still require an exact whole-token dictionary hit, so the
 * extra pass cannot introduce a substring false positive.
 */
function preSubstituted(text: string): string {
  return [...text].map((char) => SUBSTITUTIONS[char] ?? char).join('');
}

export interface ProfanityResult {
  clean: boolean;
  /** Normalised forms that matched — for logging, never shown verbatim. */
  matches: string[];
}

/** Full check. Returns every offending term found. */
export function checkProfanity(text: string): ProfanityResult {
  const matches: string[] = [];

  // Pass A on the raw text, pass B on the leet-substituted text.
  for (const source of [text, preSubstituted(text)]) {
    for (const raw of tokenize(source)) {
      const token = normaliseToken(raw);
      if (token.length < 2) continue;

      if (BLOCKED.has(token)) {
        matches.push(token);
        continue;
      }
      for (const stripped of hebrewPrefixStrippings(token)) {
        if (BLOCKED.has(stripped)) {
          matches.push(stripped);
          break;
        }
      }
    }
  }

  // Multi-word phrases, against the normalised token stream.
  const normalisedText = tokenize(text).map(normaliseToken).join(' ');
  for (const phrase of BLOCKED_PHRASES) {
    if (phrase && normalisedText.includes(phrase)) matches.push(phrase);
  }

  for (const candidate of spacedOutCandidates(text)) {
    if (BLOCKED.has(candidate)) matches.push(candidate);
  }

  return { clean: matches.length === 0, matches: [...new Set(matches)] };
}

/** Convenience predicate. */
export function containsProfanity(text: string): boolean {
  return !checkProfanity(text).clean;
}

/**
 * Replaces offending tokens with asterisks, preserving the original spacing.
 * Used for legacy/imported content rather than for new submissions, which are
 * rejected outright.
 */
export function censor(text: string): string {
  return text.replace(/[\p{L}\p{N}]+/gu, (word) => {
    const token = normaliseToken(word);
    const bad =
      BLOCKED.has(token) ||
      hebrewPrefixStrippings(token).some((stripped) => BLOCKED.has(stripped));
    return bad ? '*'.repeat(word.length) : word;
  });
}
