import {
  fetchDiscover,
  searchKeywords,
  searchMulti,
  type MediaDraft,
  type MediaType,
  type TmdbKeyword,
} from '@/lib/tmdb';
import type { MoodResult } from '@/types/media';

/**
 * On-device natural-language mood matcher.
 *
 * The production path is the `mood-search` Edge Function (Claude → embeddings →
 * pgvector). That needs server API keys and a real JWT, so on web, in Expo Go
 * and in mock mode we resolve the query here instead.
 *
 * ── Why this was rewritten ─────────────────────────────────────────────────
 * The previous version matched the query against a FIXED table of ~35 regexes.
 * Anything the table didn't cover produced no genres and no concepts, and the
 * resolver then fell through to an unfiltered `/discover` sorted by
 * popularity — which returns the SAME titles no matter what you type. That is
 * exactly the reported bug: different prompts, identical wrong results.
 *
 * The engine is now driven by the user's own words. Every content word (and
 * adjacent word pair) is looked up against TMDB's live keyword vocabulary, so
 * the query genuinely determines the search. A hardcoded table only survives
 * as a small colloquialism map ("grandpa" → "grandfather"), because TMDB's
 * vocabulary is formal — and that map only ever ADDS candidates, it can no
 * longer be the sole source of them.
 */

export interface MoodIntent {
  /** TMDB genre names detected in the text. */
  genres: string[];
  mediaType: MediaType | null;
  /** Content words from the query, used for keyword lookup and lexical scoring. */
  tokens: string[];
  /** Candidate phrases sent to `/search/keyword`, most specific first. */
  candidates: string[];
  /**
   * Recognised concepts, GROUPED — one inner array per concept.
   *
   * The grouping is load-bearing. Within a concept the ids are SYNONYMS
   * (hacker | hacking | computer) and must be OR-ed; across concepts they are
   * separate requirements ("cyberpunk hackers") and should be AND-ed. Flattening
   * them into one list and AND-ing everything demanded a title be tagged
   * hacker AND hacking AND computer, which only two films on TMDB satisfy —
   * technically precise, uselessly narrow.
   */
  pinnedGroups: number[][];
  /** Human-readable names of the pinned concepts, for the reply text. */
  pinnedLabels: string[];
  /** Strictest vote floor demanded by any matched concept. */
  pinnedMinVotes: number;
  /** Keywords TMDB actually recognised. Empty is a meaningful signal. */
  keywords: TmdbKeyword[];
  /** The raw text, sent verbatim to `/search/multi`. */
  raw: string;
  /**
   * The English rendering of a Hebrew query, when one could be built.
   *
   * TMDB's title index contains Hebrew TITLES but nothing else in Hebrew, so a
   * Hebrew DESCRIPTION of a work finds nothing: measured against the live API,
   * `איש עכביש` ("spider man", how the character is described) returns 0
   * results while `ספיידרמן` (the Hebrew title) returns 25 and `spider-man`
   * returns 110. Searching only the raw text therefore fails for exactly the
   * queries a Hebrew speaker is most likely to type. This carries the bridged
   * English so the title search gets a second, findable attempt.
   */
  bridged: string;
}

/**
 * Concepts pinned to KNOWN TMDB keyword ids.
 *
 * These are hard-coded on purpose. Resolving "hackers" through
 * `/search/keyword` is a guess: the index is fuzzy, the top hit for a plural or
 * a near-miss is often wrong, and — worse — a single loose keyword then gets
 * OR-ed with the genre pass, which is exactly how "a dark thriller about
 * hackers" came back with Breaking Bad. Breaking Bad is Crime; it was never a
 * hacker match, it arrived through the fallback.
 *
 * For a concept in this table the resolver takes the ids verbatim, ANDs/ORs
 * only those, and SUPPRESSES the generic genre pass entirely (see
 * `hasPinnedConcept`). Verified live: keyword 2157 alone returns The Social
 * Network, Ghost in the Shell, Swordfish, Sneakers, Hackers, Mr. Robot and
 * Person of Interest — no Breaking Bad anywhere.
 *
 * Every id below was confirmed against /search/keyword rather than assumed.
 */
interface PinnedConcept {
  match: RegExp;
  /** TMDB keyword ids. Within a concept these are SYNONYMS and get OR-ed. */
  ids: number[];
  label: string;
  /**
   * Genres that narrow this concept. Only ever ANDs — never adds — so it
   * cannot reintroduce the generic-genre pollution precision mode exists to
   * prevent.
   */
  genres?: string[];
  /**
   * Vote floor for this concept's discover pass.
   *
   * Vibe concepts need a much higher floor than topic concepts. A topical
   * keyword like `hacker` is specific enough that an obscure match is still a
   * real match, but an emotional keyword like `sad` is attached to thousands of
   * titles and at a low floor the shelf fills with films nobody has heard of.
   */
  minVotes?: number;
}

const PINNED_CONCEPTS: PinnedConcept[] = [
  // Every id below was read back from /search/keyword as an EXACT name match.
  { match: /\bhack(er|ers|ing)?\b|\bcyber\b|\bdark ?net\b/i, ids: [2157, 12361, 6104], label: 'hacker' },
  { match: /\bcyberpunk\b/i, ids: [12190, 2157], label: 'cyberpunk' },
  { match: /\btime ?travel(l?ing)?\b/i, ids: [4379], label: 'time travel' },
  { match: /\bzombie(s)?\b|\bundead\b/i, ids: [12377], label: 'zombie' },
  { match: /\bvampire(s)?\b/i, ids: [3133], label: 'vampire' },
  { match: /\bheist(s)?\b|\bbank robbery\b/i, ids: [10051], label: 'heist' },
  { match: /\bserial killer(s)?\b/i, ids: [10714], label: 'serial killer' },
  { match: /\bspy|espionage|secret agent\b/i, ids: [5265], label: 'espionage' },
  { match: /\bsuperhero(es)?\b/i, ids: [9715], label: 'superhero' },
  { match: /\bpost.?apocalyp\w*\b|\bapocalypse\b/i, ids: [359337], label: 'post-apocalyptic' },
  { match: /\bdystopia(n)?\b/i, ids: [4565], label: 'dystopia' },
  {
    match: /\bartificial intelligence\b|\brobot(s)?\b|\bandroid(s)?\b/i,
    ids: [378084, 14544],
    label: 'artificial intelligence',
  },
  { match: /\bastronaut(s)?\b|\binterstellar\b|\bouter space\b/i, ids: [9882], label: 'space' },
  { match: /\balien(s)?\b|\bextraterrestrial\b/i, ids: [9951], label: 'alien' },
  { match: /\bgrand(pa|father|dad)\b/i, ids: [4412], label: 'grandfather' },
  { match: /\bcook(ing)?\b|\bchef(s)?\b|\bculinary\b/i, ids: [1918], label: 'cooking' },
  { match: /\bprison\b|\bjail\b/i, ids: [378], label: 'prison' },
  { match: /\bmafia\b|\bcartel\b|\bdrug lord\b/i, ids: [10391], label: 'mafia' },
  { match: /\bwitch(es)?\b|\bwizard(s)?\b|\bmagic(al)?\b/i, ids: [2343], label: 'magic' },
  { match: /\bdragon(s)?\b/i, ids: [12554], label: 'dragon' },
  { match: /\bpirate(s)?\b/i, ids: [12988], label: 'pirate' },
  { match: /\bsurvival\b|\bstranded\b/i, ids: [10349], label: 'survival' },
  { match: /\brevenge\b|\bvengeance\b/i, ids: [9748], label: 'revenge' },
];

/**
 * EMOTIONAL and SITUATIONAL concepts — "what do I feel like", not "what is it about".
 *
 * ── The bug these fix ──────────────────────────────────────────────────────
 * Typing "make me cry" used to return *Pickles Make Me Cry* (1988) and *These
 * Onions Don't Make Me Cry* (1997). Nothing was malfunctioning: no topic
 * keyword matched, so the resolver fell through to `/search/multi`, which does
 * exactly what it says — it looks for those WORDS IN TITLES. "something to
 * watch after a bad breakup" returned nothing at all for the same reason.
 *
 * A vibe query is precisely the case where the literal words must NOT be
 * searched for. Matching one puts the resolver into precision mode, which
 * suppresses the text-search pass entirely and searches for the FEELING
 * instead, via TMDB's curated emotional keywords.
 *
 * Every id below was read back from `/search/keyword` as an exact name match
 * and then spot-checked against `/discover` for result quality:
 *   tearjerker|sad|grief + Drama → The Pianist, The Holdovers, A Real Pain
 *   breakup|heartbreak|divorce   → Eternal Sunshine, Her, Vanilla Sky
 *   feelgood|uplifting|wholesome → Forrest Gump, The Intouchables, Green Book
 *
 * This table is inherently finite — it is a curated map, not comprehension.
 * The general solution is the LLM planner (src/lib/moodPlanner.ts), which
 * handles arbitrary phrasing; this is the floor that keeps the feature honest
 * when no model is configured.
 */
const VIBE_CONCEPTS: PinnedConcept[] = [
  {
    match:
      /\bmakes? me cry\b|\b(want|need) to cry\b|\bgood cry\b|\btear.?jerker\b|\bsomething sad\b|\breally sad\b|\bheart.?breaking\b|\bmake me sob\b|\bcry my eyes out\b/i,
    ids: [156924, 276222, 9872], // tearjerker, sad, grief
    genres: ['Drama'],
    label: 'tearjerker',
    minVotes: 250,
  },
  {
    match:
      /\bbreak.?up\b|\bbroken heart\b|\bheart.?break\b|\bgot dumped\b|\bdivorce\b|\bafter a relationship\b|\bmoving on from\b/i,
    ids: [365758, 34265, 15160], // breakup, heartbreak, divorce
    label: 'heartbreak',
    minVotes: 200,
  },
  {
    match:
      /\bfeel.?good\b|\bcheer (me|myself) up\b|\bpick.?me.?up\b|\buplifting\b|\bwholesome\b|\bcomfort (movie|watch|show|film)\b|\bsomething happy\b|\bin a good mood\b/i,
    ids: [275276, 334465, 335803], // feelgood, uplifting, wholesome
    label: 'feel-good',
    minVotes: 200,
  },
  {
    match: /\bcoming.of.age\b|\bgrowing up\b|\bteen(age|ager)?\b|\badolescen\w*\b/i,
    ids: [10683], // coming of age
    label: 'coming of age',
    minVotes: 150,
  },
  {
    match: /\blonely\b|\bloneliness\b|\bisolat(ed|ion)\b|\bfeeling alone\b/i,
    ids: [9957], // loneliness
    genres: ['Drama'],
    label: 'loneliness',
    minVotes: 150,
  },
  {
    match:
      /\bdate night\b|\bwith my (girlfriend|boyfriend|wife|husband|partner)\b|\bromantic evening\b/i,
    ids: [380334, 9673], // romantic comedy, love
    label: 'date night',
    minVotes: 300,
  },
  {
    match:
      /\bwith (my )?(kids|children|family|parents|mum|mom|dad|grandma|grandmother|grandpa|grandfather)\b|\bfamily (night|movie night)\b|\beveryone can watch\b/i,
    ids: [6054], // friendship
    genres: ['Family', 'Adventure'],
    label: 'family night',
    minVotes: 400,
  },
];

/** Topic concepts plus vibe concepts — both drive precision mode. */
const ALL_CONCEPTS: PinnedConcept[] = [...PINNED_CONCEPTS, ...VIBE_CONCEPTS];

/**
 * Colloquial → TMDB vocabulary. TMDB tags titles with formal terms, so a few
 * everyday words need translating before lookup.
 *
 * This ADDS a candidate; the original word is still looked up too. The list is
 * intentionally small — it is a courtesy layer, not the engine.
 */
const SYNONYMS: Record<string, string> = {
  grandpa: 'grandfather',
  granddad: 'grandfather',
  grandad: 'grandfather',
  gramps: 'grandfather',
  grandma: 'grandmother',
  granny: 'grandmother',
  dad: 'father',
  mom: 'mother',
  mum: 'mother',
  kid: 'child',
  kids: 'children',
  ai: 'artificial intelligence',
  scifi: 'science fiction',
  spaceship: 'spacecraft',
  aliens: 'alien',
  zombies: 'zombie',
  robots: 'robot',
  vampires: 'vampire',
  hackers: 'hacker',
  wizards: 'wizard',
  dragons: 'dragon',
  detectives: 'detective',
  heists: 'heist',
  apocalypse: 'post-apocalyptic',
  dystopian: 'dystopia',
};

/**
 * Hebrew → TMDB keyword vocabulary.
 *
 * TMDB's keyword index is English-only, so a Hebrew query resolves NO keywords
 * at all on its own — "סדרה על מלחמה" produced nothing and fell through to the
 * generic pass. Bridging the concepts into English restores the keyword engine
 * for Hebrew, while `/search/multi` still runs on the original Hebrew text
 * (TMDB *does* index Hebrew titles, so that half already worked).
 */
const HEBREW_CONCEPTS: Record<string, string> = {
  מלחמה: 'war',
  חייל: 'soldier',
  צבא: 'military',
  האקר: 'hacker',
  האקרים: 'hacker',
  מחשב: 'computer',
  זומבי: 'zombie',
  זומבים: 'zombie',
  ערפד: 'vampire',
  ערפדים: 'vampire',
  רובוט: 'robot',
  חייזר: 'alien',
  חייזרים: 'alien',
  חלל: 'space',
  סבא: 'grandfather',
  סבתא: 'grandmother',
  אבא: 'father',
  אמא: 'mother',
  משפחה: 'family',
  ילד: 'child',
  ילדים: 'children',
  נוער: 'coming of age',
  חברות: 'friendship',
  שוד: 'heist',
  בלש: 'detective',
  רצח: 'murder',
  מרגל: 'spy',
  כלא: 'prison',
  ריגול: 'espionage',
  קסם: 'magic',
  קוסם: 'wizard',
  דרקון: 'dragon',
  פיראט: 'pirate',
  ספורט: 'sport',
  כדורגל: 'football',
  בישול: 'cooking',
  אוכל: 'food',
  מוזיקה: 'music',
  רופא: 'doctor',
  'בית חולים': 'hospital',
  משפט: 'courtroom',
  'עורך דין': 'lawyer',
  סמים: 'drugs',
  מאפיה: 'mafia',
  נקמה: 'revenge',
  הישרדות: 'survival',
  אפוקליפסה: 'post-apocalyptic',
  עתיד: 'future',
  היסטוריה: 'history',
  שואה: 'holocaust',
  ישראל: 'israel',
  ישראלי: 'israel',
  טרור: 'terrorism',
  מסע: 'journey',
  הרפתקה: 'adventure',
  אהבה: 'love',
  בגידה: 'betrayal',
  'מסע בזמן': 'time travel',
  'גיבור על': 'superhero',
  'בית ספר': 'school',

  /*
    Characters Hebrew DESCRIBES rather than transliterates.

    Most franchise names need nothing here: measured against the live API,
    `באטמן`, `מלחמת הכוכבים`, `הארי פוטר`, `שר הטבעות`, `נוקמים` and `אנטמן`
    all return results from the raw text, because those ARE the Hebrew titles.
    The entries below are the measured exceptions — the ones where Hebrew uses
    a literal description that appears in no title, so the raw search returns
    exactly zero:

      איש עכביש    0 raw → spider-man 110
      איש הברזל    0 raw → iron man   112
      אישה חתולה   0 raw → catwoman    14

    This list is deliberately short and is NOT the general solution — no fixed
    table can cover a language. It is the floor for the offline resolver; the
    LLM planner is what generalises, and it translates before it extracts.
  */
  'איש עכביש': 'spider-man',
  'איש העכביש': 'spider-man',
  'איש הברזל': 'iron man',
  'אישה חתולה': 'catwoman',
  'אשה חתולה': 'catwoman',
};

/** Hebrew phrase → TMDB genre names. */
const HEBREW_GENRE_HINTS: Array<[RegExp, string[]]> = [
  [/מדע בדיוני|עתידני/, ['Science Fiction']],
  [/מותחן|מתח/, ['Thriller']],
  [/אימה|מפחיד|מצמרר/, ['Horror']],
  [/קומדיה|מצחיק|מצחיקה|קליל/, ['Comedy']],
  [/רומנט|אהבה/, ['Romance']],
  [/תיעודי|דוקומנטרי/, ['Documentary']],
  [/אנימציה|מצויר|אנימה/, ['Animation']],
  [/דרמה|מרגש/, ['Drama']],
  [/אקשן|פעולה/, ['Action']],
  [/הרפתק/, ['Adventure']],
  [/פשע|מאפיה|פושע/, ['Crime']],
  [/מסתורין|תעלומה/, ['Mystery']],
  [/פנטזיה|קסם|קוסם|דרקון/, ['Fantasy']],
  [/משפחתי|ילדים|נוער/, ['Family']],
  [/מלחמה|צבא|חייל/, ['War']],
  [/מערבון|קאובוי/, ['Western']],
];

/** Hebrew function words that carry no topic. */
const HEBREW_STOP_WORDS = new Set([
  'של', 'עם', 'על', 'את', 'זה', 'הוא', 'היא', 'הם', 'אני', 'אנחנו', 'יש', 'אין',
  'לא', 'כן', 'רוצה', 'מחפש', 'מחפשת', 'משהו', 'משו', 'סרט', 'סרטים', 'סדרה',
  'סדרות', 'להערב', 'הערב', 'עכשיו', 'היום', 'טוב', 'טובה', 'מאוד', 'כמו',
  'בבקשה', 'תן', 'תני', 'איזה', 'איזו', 'מה', 'למה', 'איך', 'הכי', 'גם',
]);

/** True when the text contains Hebrew letters. */
function hasHebrew(text: string): boolean {
  return /[֐-׿]/.test(text);
}

/** Phrase → TMDB genre names. Order matters: longer phrases match first. */
const GENRE_HINTS: Array<[RegExp, string[]]> = [
  [/\bsci[-\s]?fi|science fiction|dystopia|cyberpunk|futuristic\b/i, ['Science Fiction']],
  [/\bmind[-\s]?bend|trippy|surreal\b/i, ['Science Fiction', 'Mystery']],
  [/\bthriller|suspense|tense|edge of my seat\b/i, ['Thriller']],
  [/\bhorror|scary|terrifying|creepy|slasher\b/i, ['Horror']],
  [/\bcomedy|funny|hilarious|laugh|light[-\s]?hearted|lighthearted|silly\b/i, ['Comedy']],
  [/\bromance|romantic|love story|rom[-\s]?com\b/i, ['Romance']],
  [/\bdocumentar|true story|real life\b/i, ['Documentary']],
  [/\banimation|animated|cartoon|anime\b/i, ['Animation']],
  [/\bdrama|emotional|moving|tear[-\s]?jerker\b/i, ['Drama']],
  [/\baction|explosive|fight|martial arts|adrenaline\b/i, ['Action']],
  [/\badventure|epic|quest|journey\b/i, ['Adventure']],
  [/\bcrime|gangster|mafia|murder\b/i, ['Crime']],
  [/\bmystery|whodunit|puzzle\b/i, ['Mystery']],
  [/\bfantasy|magic|wizard|dragon\b/i, ['Fantasy']],
  [/\bfamily|wholesome\b/i, ['Family']],
  [/\bwar|battle|soldier|military\b/i, ['War']],
  [/\bwestern|cowboy\b/i, ['Western']],
  [/\bdark|gritty|bleak|noir\b/i, ['Crime', 'Thriller']],
  [/\bfeel[-\s]?good|cheer(ful|ing)|uplifting|cosy|cozy\b/i, ['Comedy', 'Family']],
];

const TV_HINTS = /\b(series|show|shows|tv|season|seasons|binge|episodes?)\b/i;
const MOVIE_HINTS = /\b(movie|movies|film|films|feature)\b/i;

/** Words carrying no search value. Everything else is treated as content. */
const STOP_WORDS = new Set([
  'i', 'a', 'an', 'the', 'want', 'wanna', 'need', 'watch', 'watching', 'something',
  'some', 'to', 'for', 'with', 'about', 'that', 'this', 'is', 'are', 'me', 'my',
  'we', 'us', 'our', 'his', 'her', 'their', 'its', 'him', 'them', 'they', 'he',
  'she', 'tonight', 'now', 'today', 'please', 'good', 'great', 'best', 'really',
  'very', 'kind', 'of', 'like', 'likes', 'in', 'on', 'at', 'and', 'or', 'but',
  'show', 'shows', 'movie', 'movies', 'series', 'film', 'films', 'tv', 'give',
  'find', 'looking', 'look', 'feel', 'feeling', 'mood', 'anything', 'nothing',
  'too', 'not', 'would', 'could', 'can', 'it', 'be', 'been', 'am', 'was', 'were',
  'do', 'does', 'did', 'up', 'out', 'has', 'have', 'had', 'get', 'got', 'make',
  'made', 'where', 'when', 'what', 'who', 'how', 'from', 'by', 'as', 'so', 'if',
  // Auxiliaries and gerunds that survive tokenisation but carry no topic.
  'having', 'being', 'doing', 'going', 'getting', 'featuring', 'starring', 'set',
]);

/**
 * Words we refuse to look up as keywords, even though they are content words.
 *
 * These are tone adjectives. TMDB has literal keywords for several of them and
 * they are actively misleading: "something light and funny" matched the
 * keyword `light` and returned Day Watch and Skyline — films about light.
 * GENRE_HINTS already turns these into the genre the user actually meant, so
 * they stay in `tokens` (they still contribute to lexical scoring) but never
 * reach `/search/keyword`.
 */
const VAGUE_WORDS = new Set([
  'light', 'funny', 'sad', 'happy', 'weird', 'smart', 'clever', 'nice', 'cool',
  'fun', 'boring', 'slow', 'fast', 'long', 'short', 'new', 'old', 'easy',
  'simple', 'exciting', 'interesting', 'entertaining', 'lighthearted',
]);

/** Splits into lowercase content tokens, preserving the user's own wording. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(
      (word) =>
        word.length >= 2 && !STOP_WORDS.has(word) && !HEBREW_STOP_WORDS.has(word),
    );
}

/**
 * English keyword terms implied by a Hebrew query.
 *
 * Multi-word entries ("מסע בזמן") are matched against the whole string first,
 * because tokenising splits them into halves that mean something else.
 */
function hebrewConcepts(query: string, tokens: string[]): string[] {
  const found: string[] = [];
  for (const [hebrew, english] of Object.entries(HEBREW_CONCEPTS)) {
    if (!hebrew.includes(' ')) continue;
    if (query.includes(hebrew)) found.push(english);
  }
  for (const token of tokens) {
    // Hebrew attaches ו/ה/ב/ל/כ/מ/ש as single-letter prefixes, so try the bare
    // token and then the token with one leading letter removed.
    const term = HEBREW_CONCEPTS[token] ?? HEBREW_CONCEPTS[token.slice(1)];
    if (term) found.push(term);
  }
  return [...new Set(found)];
}

/**
 * Naive singulariser. TMDB's keyword vocabulary is singular ("adventure",
 * "zombie"), but people type plurals — and TMDB *also* has sparse plural
 * keywords ("adventures") that match almost nothing, so the plural silently
 * won and the query returned junk. Both forms are tried.
 */
function singular(word: string): string | null {
  if (word.length <= 4 || word.endsWith('ss') || !word.endsWith('s')) return null;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('es') && /(ch|sh|x|z)es$/.test(word)) return word.slice(0, -2);
  return word.slice(0, -1);
}

/**
 * Builds the phrases to look up.
 *
 * Order is a spending priority, not just a preference: the lookup budget is
 * finite, and an earlier version put every adjacent pair first, so on "a boy
 * having adventures with his grandpa" the budget was exhausted by junk bigrams
 * and the one word that mattered — grandpa → grandfather — was never looked up
 * at all. Normalised single words now come first.
 */
function buildCandidates(tokens: string[]): string[] {
  const lookupTokens = tokens.filter((token) => !VAGUE_WORDS.has(token));

  const normalised: string[] = [];
  const plain: string[] = [];
  for (const token of lookupTokens) {
    const synonym = SYNONYMS[token];
    if (synonym) normalised.push(synonym);
    const base = singular(token);
    if (base && !SYNONYMS[token]) normalised.push(base);
    plain.push(token);
  }

  // Adjacent pairs still matter ("time travel", "serial killer" are single
  // keywords whose halves mean something else) — just not at any price.
  const pairs: string[] = [];
  for (let i = 0; i < lookupTokens.length - 1; i++) {
    pairs.push(`${lookupTokens[i]} ${lookupTokens[i + 1]}`);
  }

  return [...new Set([...normalised, ...pairs.slice(0, 3), ...plain])];
}

/** Parses the query. Pure and synchronous — no network. */
export function parseMoodQuery(query: string): Omit<MoodIntent, 'keywords'> {
  const hebrew = hasHebrew(query);

  const genres = new Set<string>();
  for (const [pattern, names] of GENRE_HINTS) {
    if (pattern.test(query)) names.forEach((name) => genres.add(name));
  }
  if (hebrew) {
    for (const [pattern, names] of HEBREW_GENRE_HINTS) {
      if (pattern.test(query)) names.forEach((name) => genres.add(name));
    }
  }

  // NOTE: no \b on the Hebrew patterns. JS word boundaries are defined against
  // [A-Za-z0-9_], so every Hebrew letter counts as a NON-word character and
  // `\bסרט` can never match — the format hint silently did nothing.
  let mediaType: MediaType | null = null;
  if (TV_HINTS.test(query) || /סדרה|סדרות|עונה|עונות/.test(query)) mediaType = 'tv';
  else if (MOVIE_HINTS.test(query) || /סרט|סרטים|סרטון/.test(query)) mediaType = 'movie';

  const tokens = tokenize(query);

  // Hebrew concepts are bridged to English and put FIRST, ahead of the raw
  // tokens — the raw Hebrew will never match TMDB's English keyword index, so
  // spending the lookup budget on it would waste the whole pass.
  const bridged = hebrew ? hebrewConcepts(query.toLowerCase(), tokens) : [];
  const candidates = [...new Set([...bridged, ...buildCandidates(tokens)])];

  // Concepts with known ids, matched against the raw text (and, for Hebrew,
  // against the bridged English terms so "האקרים" pins the hacker ids too).
  const bridgedText = bridged.join(' ');
  const pinnedGroups: number[][] = [];
  const pinnedLabels: string[] = [];
  let pinnedMinVotes = 0;
  for (const concept of ALL_CONCEPTS) {
    if (concept.match.test(query) || (bridgedText && concept.match.test(bridgedText))) {
      pinnedGroups.push([...concept.ids]);
      pinnedLabels.push(concept.label);
      // A concept's own genres NARROW its precision pass. Added here so they
      // travel with the concept rather than depending on the loose keyword
      // hints happening to fire on the same sentence.
      for (const genre of concept.genres ?? []) genres.add(genre);
      pinnedMinVotes = Math.max(pinnedMinVotes, concept.minVotes ?? 0);
    }
  }

  return {
    genres: [...genres],
    mediaType,
    tokens,
    candidates,
    pinnedGroups,
    pinnedLabels,
    pinnedMinVotes,
    raw: query.trim(),
    bridged: bridgedText,
  };
}

/** Shared by the local resolver and the LLM planner — one result shape. */
export function draftToResult(draft: MediaDraft, similarity: number): MoodResult {
  return {
    id: `mood-${draft.media_type}-${draft.tmdb_id}`,
    tmdb_id: draft.tmdb_id,
    media_type: draft.media_type,
    title: draft.title,
    overview: draft.overview,
    poster_path: draft.poster_path,
    backdrop_path: draft.backdrop_path,
    genres: draft.genres,
    runtime_minutes: draft.runtime_minutes,
    release_year: draft.release_year,
    vote_average: draft.vote_average,
    similarity,
  };
}

/**
 * How a candidate was found. `keywordAll` means it carried EVERY keyword we
 * resolved — the strongest possible signal for a descriptive query.
 */
type MatchSource = 'keywordAll' | 'keywordAny' | 'search' | 'genre';

const SOURCE_WEIGHT: Record<MatchSource, number> = {
  keywordAll: 0.34,
  keywordAny: 0.2,
  search: 0.18,
  genre: 0.04,
};

/**
 * Scores a candidate against the intent.
 *
 * Lexical overlap is deliberately part of the score: it ties the ranking to
 * the literal words the user typed, which is what guarantees two different
 * prompts cannot produce an identically-ordered list.
 */
function score(
  draft: MediaDraft,
  intent: MoodIntent,
  sources: Set<MatchSource>,
): number {
  let value = 0.32;

  // Best single source, plus a bonus for corroboration across passes.
  let best = 0;
  for (const source of sources) best = Math.max(best, SOURCE_WEIGHT[source]);
  value += best;
  if (sources.size > 1) value += 0.06;

  if (intent.tokens.length > 0) {
    const haystack = `${draft.title} ${draft.overview ?? ''}`.toLowerCase();
    const hits = intent.tokens.filter((token) => haystack.includes(token)).length;
    value += (hits / intent.tokens.length) * 0.18;
  }

  if (intent.genres.length > 0) {
    const overlap = draft.genres.filter((genre) => intent.genres.includes(genre)).length;
    value += Math.min(overlap / intent.genres.length, 1) * 0.12;
  }

  if (intent.mediaType && draft.media_type === intent.mediaType) value += 0.05;
  if (draft.vote_average != null) value += Math.min(draft.vote_average / 10, 1) * 0.08;

  return Math.min(value, 0.99);
}

export interface MoodResolution {
  intent: MoodIntent;
  results: MoodResult[];
}

/** Small helper so one failing TMDB call can't sink the whole resolution. */
function safe<T>(promise: Promise<T[]>): Promise<T[]> {
  return promise.catch(() => [] as T[]);
}

/** How many phrases we're willing to spend a keyword lookup on. */
const MAX_CANDIDATES = 8;
/** Keyword ids carried into discover. More than this returns mush. */
const MAX_KEYWORDS = 4;

/**
 * Resolves a natural-language mood query into ranked TMDB titles.
 *
 * Passes, strongest first:
 *  1. **Keywords (AND)** — titles tagged with EVERY resolved concept. This is
 *     what answers "a boy having adventures with his grandpa".
 *  2. **Keywords (OR)** — the recall net when the AND is too narrow.
 *  3. **Text search** — `/search/multi` on the raw text, for titles, actors
 *     and franchises. Always runs, so a query naming something concrete
 *     always finds it.
 *  4. **Genre discovery** — only when the text actually named a genre.
 *
 * There is deliberately NO unfiltered fallback. If none of these match, the
 * honest answer is "no results", not a generic popularity list that looks like
 * an answer but ignores the question.
 *
 * Known limit: TMDB's keyword vocabulary is English-only, so a Hebrew query
 * resolves through passes 3 and 4 only.
 */
export async function resolveMoodLocally(
  query: string,
  locale: 'en' | 'he',
): Promise<MoodResolution> {
  const parsed = parseMoodQuery(query);
  const types: MediaType[] = parsed.mediaType ? [parsed.mediaType] : ['movie', 'tv'];
  const byTypeEarly = <T,>(run: (type: MediaType) => Promise<T[]>): Promise<T[]> =>
    Promise.all(types.map(run)).then((pages) => pages.flat());

  // ── PRECISION MODE ──────────────────────────────────────────────────────
  //
  // A recognised concept ends the search here. No fuzzy keyword lookup, no
  // genre backstop, no text search — those are RECALL mechanisms, and mixing
  // recall into a precise query is exactly what put Breaking Bad in the results
  // for "a dark thriller about hackers": the hacker keyword was right, and then
  // the Crime/Thriller genre pass buried it under generic crime drama.
  //
  // Genre still narrows (AND) when the user named one, but it can never ADD.
  if (parsed.pinnedGroups.length > 0) {
    const intent: MoodIntent = { ...parsed, keywords: [] };
    const groups = parsed.pinnedGroups;
    /** One canonical id per concept — the head of each synonym group. */
    const canonical = groups.map((group) => group[0]!).filter((id) => id != null);
    /** Every synonym of every concept, for the widest precise net. */
    const union = [...new Set(groups.flat())];

    const run = (ids: number[], mode: 'and' | 'or', genres?: string[]) =>
      byTypeEarly((type) =>
        safe(
          fetchDiscover(type, {
            page: 1,
            locale,
            keywordIds: ids,
            keywordMode: mode,
            genres,
            // Vibe concepts raise this well above the topical default — see
            // PinnedConcept.minVotes.
            minVotes: Math.max(30, parsed.pinnedMinVotes),
            sortBy: 'popularity.desc',
          }),
        ),
      );

    /**
     * Narrow → wide, stopping at the first pass that returns anything.
     *
     * TMDB's `with_keywords` cannot express "(A|B) AND (C|D)" — comma is AND,
     * pipe is OR, and they don't nest. So multi-concept queries AND the
     * canonical id of each concept, which is expressible and still precise.
     */
    let hits: MediaDraft[] = [];

    // 1. Multiple concepts, all required ("cyberpunk hackers").
    if (canonical.length >= 2) hits = await run(canonical, 'and');

    // 2. All synonyms of the concept(s), narrowed by any genre the user named.
    //    This is the workhorse for "a dark thriller about hackers".
    if (hits.length === 0 && intent.genres.length > 0) {
      hits = await run(union, 'or', intent.genres);
    }

    // 3. All synonyms, no genre narrowing.
    if (hits.length === 0) hits = await run(union, 'or');

    const ranked = new Map<string, MediaDraft>();
    for (const draft of hits) {
      if (intent.mediaType && draft.media_type !== intent.mediaType) continue;
      ranked.set(`${draft.media_type}:${draft.tmdb_id}`, draft);
    }

    const results = [...ranked.values()]
      .map((draft) => ({ draft, value: score(draft, intent, new Set(['keywordAll'])) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12)
      .map((entry) => draftToResult(entry.draft, entry.value));

    // Only fall through to the general engine if precision found NOTHING at
    // all — an empty precise answer is still better than a wrong broad one, but
    // a genuinely unmatched concept deserves the wider net.
    if (results.length > 0) return { intent, results };
  }

  // ── Resolve the user's own words against TMDB's keyword vocabulary ──────
  const looked = await Promise.all(
    parsed.candidates
      .slice(0, MAX_CANDIDATES)
      .map((candidate) => safe(searchKeywords(candidate, 1))),
  );

  const keywords: TmdbKeyword[] = [];
  const seenKeyword = new Set<number>();
  for (const found of looked) {
    for (const keyword of found) {
      if (seenKeyword.has(keyword.id)) continue;
      seenKeyword.add(keyword.id);
      keywords.push(keyword);
    }
  }

  /**
   * Most specific first. A multi-word keyword ("time travel") pins a title
   * down; a short generic one ("boy") does not, and AND-ing on it throws away
   * everything useful.
   *
   * Ties keep CANDIDATE order, which is already ranked by confidence
   * (normalised forms before raw ones). Sorting ties by name length instead
   * ranked the sparse plural keyword `adventures` above `adventure` and the
   * AND pass then matched nothing. Array.sort is stable per spec, so this
   * comparator returning 0 preserves that order.
   */
  keywords.sort((a, b) => b.name.split(' ').length - a.name.split(' ').length);

  const intent: MoodIntent = { ...parsed, keywords };
  const keywordIds = keywords.slice(0, MAX_KEYWORDS).map((keyword) => keyword.id);

  const byType = <T,>(run: (type: MediaType) => Promise<T[]>): Promise<T[]> =>
    Promise.all(types.map(run)).then((pages) => pages.flat());

  /**
   * AND-ing every resolved keyword is usually too narrow to return anything
   * ("grandfather AND boy AND adventure AND grandpa" matches nothing), so
   * widen by dropping the least specific until something lands.
   */
  const narrowingAnd = async (): Promise<MediaDraft[]> => {
    for (let take = Math.min(keywordIds.length, 3); take >= 2; take--) {
      const hits = await byType((type) =>
        safe(
          fetchDiscover(type, {
            page: 1,
            locale,
            keywordIds: keywordIds.slice(0, take),
            keywordMode: 'and',
            minVotes: 5,
          }),
        ),
      );
      if (hits.length > 0) return hits;
    }
    return [];
  };

  const [keywordAll, keywordAny, searched, genreHits] = await Promise.all([
    keywordIds.length >= 2 ? narrowingAnd() : Promise.resolve<MediaDraft[]>([]),

    keywordIds.length > 0
      ? byType((type) =>
          safe(
            fetchDiscover(type, {
              page: 1,
              locale,
              keywordIds,
              keywordMode: 'or',
              // Genres would AND with the keywords and can empty the result
              // set; the keywords are the more precise signal already.
              //
              // The floor is deliberately high for the OR pass. It is the
              // widest net here, and at a low threshold a single loose keyword
              // dredges up titles nobody has heard of — a vague query once
              // returned a 1906 short at the top. The precise AND pass below
              // keeps its low floor, because there a match is meaningful.
              minVotes: 150,
            }),
          ),
        )
      : Promise.resolve<MediaDraft[]>([]),

    /*
      Title search. Runs on the RAW text the user typed, and — when the query
      was Hebrew and we managed to bridge any of it — on the English rendering
      too.

      The second attempt is what makes a Hebrew request for a named work work
      at all. TMDB indexes Hebrew titles but not Hebrew descriptions, so the
      raw pass finds a title only when the user happened to type the Hebrew
      title itself; describe the same work instead and it returns nothing. The
      bridged pass covers the describing case. Both are merged, so a query that
      matches either way keeps both sets of hits.
    */
    intent.raw.length >= 2
      ? Promise.all([
          safe(searchMulti(intent.raw, locale)),
          intent.bridged.length >= 2
            ? safe(searchMulti(intent.bridged, locale))
            : Promise.resolve<MediaDraft[]>([]),
        ]).then(([rawHits, bridgedHits]) => [...rawHits, ...bridgedHits])
      : Promise.resolve<MediaDraft[]>([]),

    intent.genres.length > 0
      ? byType((type) =>
          safe(fetchDiscover(type, { page: 1, locale, genres: intent.genres, minVotes: 150 })),
        )
      : Promise.resolve<MediaDraft[]>([]),
  ]);

  // ── Merge, tracking every pass a title was found by ────────────────────
  const found = new Map<string, { draft: MediaDraft; sources: Set<MatchSource> }>();

  const add = (draft: MediaDraft, source: MatchSource) => {
    if (intent.mediaType && draft.media_type !== intent.mediaType) return;
    const key = `${draft.media_type}:${draft.tmdb_id}`;
    const existing = found.get(key);
    if (existing) existing.sources.add(source);
    else found.set(key, { draft, sources: new Set([source]) });
  };

  for (const draft of keywordAll) add(draft, 'keywordAll');
  for (const draft of keywordAny) add(draft, 'keywordAny');
  for (const draft of searched) add(draft, 'search');
  for (const draft of genreHits) add(draft, 'genre');

  const results = [...found.values()]
    .map((entry) => ({ entry, value: score(entry.draft, intent, entry.sources) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12)
    .map(({ entry, value }) => draftToResult(entry.draft, value));

  return { intent, results };
}
