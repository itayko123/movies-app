import { z } from 'zod';
import { completeStructured, llmAvailable } from '@/lib/llm';
import {
  GENRE_CATALOG,
  fetchDiscover,
  searchKeywords,
  searchMulti,
  searchPeople,
  type MediaDraft,
  type MediaType,
} from '@/lib/tmdb';
import { draftToResult } from '@/lib/moodResolver';
import type { MoodResult } from '@/types/media';

/**
 * AI mood engine: natural language → a structured TMDB query.
 *
 * ── The one architectural rule ─────────────────────────────────────────────
 * The model PLANS. TMDB RETRIEVES. The LLM never names a single title.
 *
 * This is not a stylistic preference. Asked directly for recommendations, a
 * language model will happily return films that do not exist, films with the
 * wrong year, or films it cannot know are unavailable in the user's region —
 * and every one of them arrives with total confidence and no poster, no
 * rating, and no id to open a detail page with. Constraining the model to emit
 * only a QUERY (genre ids, English keyword phrases, people, bounds) means:
 *
 *   • every returned title provably exists, because TMDB returned it;
 *   • posters, ratings, runtimes and detail links all work;
 *   • a hallucinated genre or keyword simply resolves to nothing and is
 *     dropped, instead of becoming a fake recommendation.
 *
 * The model contributes exactly what it is good at — understanding that "after
 * a bad breakup" means heartbreak, comfort and probably not a war epic — and
 * nothing it is bad at.
 */

/** Canonical genre vocabulary the model is allowed to use. */
const GENRE_NAMES = Object.keys(GENRE_CATALOG);
const GENRE_SET = new Set(GENRE_NAMES);

/**
 * Schema for the model's answer.
 *
 * Every field is optional with a default. A model that omits `excludeGenres`
 * has still produced a usable plan, and rejecting the whole response over one
 * missing array would throw away a good answer for no reason. Validation here
 * is about never letting UNEXPECTED SHAPES through — not about demanding
 * completeness.
 */
export const MoodPlanSchema = z.object({
  /**
   * What kind of request this is.
   *  • title — the user named a specific film/show/franchise ("spider man")
   *  • topic — a subject ("movies about hackers")
   *  • vibe  — a feeling or situation ("something to cheer me up")
   */
  intent: z.enum(['title', 'topic', 'vibe']).catch('topic'),
  /** Set only for `title` intent: the thing to look up verbatim. */
  titleQuery: z.string().nullish().default(null),
  genres: z.array(z.string()).nullish().default([]),
  excludeGenres: z.array(z.string()).nullish().default([]),
  /** ENGLISH keyword phrases — TMDB's keyword index has no other language. */
  keywords: z.array(z.string()).nullish().default([]),
  /** Actor or director names. */
  people: z.array(z.string()).nullish().default([]),
  mediaType: z.enum(['movie', 'tv']).nullish().default(null),
  minRating: z.number().min(0).max(10).nullish().default(null),
  yearFrom: z.number().int().min(1880).max(2100).nullish().default(null),
  yearTo: z.number().int().min(1880).max(2100).nullish().default(null),
  /** One short sentence back to the user, in THEIR language. */
  reply: z.string().nullish().default(null),
});

export type MoodPlan = z.infer<typeof MoodPlanSchema>;

/** A plan with hallucinated / unusable values removed. */
export interface CleanPlan {
  intent: MoodPlan['intent'];
  titleQuery: string | null;
  genres: string[];
  excludeGenres: string[];
  keywords: string[];
  people: string[];
  mediaType: MediaType | null;
  minRating: number | null;
  yearFrom: number | null;
  yearTo: number | null;
  reply: string | null;
}

/** Keyword phrases sent to TMDB per query. Beyond this the result is mush. */
const MAX_KEYWORDS = 5;
const MAX_PEOPLE = 3;

function buildSystemPrompt(locale: 'en' | 'he'): string {
  return [
    'You are a movie recommendation engine. You translate a movie/TV request written in natural language into a structured search query for The Movie Database (TMDB).',
    '',
    'Output ONLY a valid JSON object. No prose, no explanation, no markdown, no code fences. The very first character of your response must be "{" and the last must be "}".',
    '',
    'You do NOT recommend titles. You never name films or shows. You only describe HOW TO SEARCH for them.',
    '',
    'STEP 1 — TRANSLATE. The user may write in Hebrew or any other language. Before anything else, translate their request into English in your head. TMDB is an English-language index: its keyword vocabulary, its character names and its canonical titles are all English, so every searchable value you emit must be English. Do not transliterate and do not pass the user\'s original words through.',
    'For example, a Hebrew request for a film about the character known in Hebrew as "איש עכביש" is a request about "Spider-Man", and that — not the Hebrew — is what belongs in the query.',
    'STEP 2 — EXTRACT. Turn the English reading into the fields below.',
    '',
    'Return ONLY a JSON object with these fields:',
    '{',
    '  "intent": "title" | "topic" | "vibe",',
    '  "titleQuery": string | null,',
    '  "genres": string[],',
    '  "excludeGenres": string[],',
    '  "keywords": string[],',
    '  "people": string[],',
    '  "mediaType": "movie" | "tv" | null,',
    '  "minRating": number | null,',
    '  "yearFrom": number | null,',
    '  "yearTo": number | null,',
    '  "reply": string',
    '}',
    '',
    'Rules:',
    `- "genres" and "excludeGenres" MUST come from exactly this list, verbatim: ${GENRE_NAMES.join(', ')}. Use [] if none apply. Never invent a genre.`,
    '- "keywords" MUST be lowercase ENGLISH terms that plausibly exist in TMDB\'s curated keyword vocabulary (e.g. "tearjerker", "heist", "time travel", "coming of age", "father son relationship"). TMDB keywords are English-only regardless of the user\'s language. Prefer 2-4 precise concepts over many vague ones. Do not put genres, moods-as-adjectives ("good", "light") or title words here.',
    '- "intent": use "title" ONLY when the user names a specific work, franchise or character. Use "vibe" for feelings, occasions and situations. Use "topic" for subjects and themes.',
    '- "titleQuery": the ENGLISH / internationally canonical name of that work, franchise or character — never the user\'s own words if they wrote in another language. When the user names a CHARACTER rather than a film, also add that character as a keyword, because TMDB indexes characters as keywords.',
    '- "people": real actor or director names ONLY if the user mentioned or clearly implied one. Otherwise [].',
    '- "mediaType": set only if the user asked for a film or a series specifically.',
    '- For an emotional or situational request, translate the FEELING into concrete searchable concepts. Example: a request about recovering from a relationship ending maps to keywords like "heartbreak", "breakup", "divorce" and genres like Drama or Romance — not to the literal words the user typed.',
    `- "reply": one short friendly sentence, written in ${locale === 'he' ? 'HEBREW' : 'ENGLISH'}, describing what you are about to look for. Do not mention TMDB, JSON, keywords or genres by name.`,
    '',
    'Output raw JSON only. No markdown, no code fences, no commentary.',
  ].join('\n');
}

/** Drops anything the model invented and clamps the rest to usable ranges. */
function sanitize(plan: MoodPlan): CleanPlan {
  const genres = (plan.genres ?? []).filter((g) => GENRE_SET.has(g));
  const excludeGenres = (plan.excludeGenres ?? [])
    .filter((g) => GENRE_SET.has(g))
    // A genre cannot be both wanted and excluded; the positive wins.
    .filter((g) => !genres.includes(g));

  const keywords = [
    ...new Set(
      (plan.keywords ?? [])
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k.length >= 3 && k.length <= 40),
    ),
  ].slice(0, MAX_KEYWORDS);

  const people = [
    ...new Set((plan.people ?? []).map((p) => p.trim()).filter((p) => p.length >= 2)),
  ].slice(0, MAX_PEOPLE);

  const titleQuery = plan.titleQuery?.trim() || null;

  // Swapped bounds are a common model slip and silently return nothing.
  let { yearFrom, yearTo } = plan;
  if (yearFrom != null && yearTo != null && yearFrom > yearTo) {
    [yearFrom, yearTo] = [yearTo, yearFrom];
  }

  return {
    intent: plan.intent,
    titleQuery,
    genres,
    excludeGenres,
    keywords,
    people,
    mediaType: plan.mediaType ?? null,
    minRating: plan.minRating ?? null,
    yearFrom: yearFrom ?? null,
    yearTo: yearTo ?? null,
    reply: plan.reply?.trim() || null,
  };
}

/** True when the plan contains nothing TMDB could act on. */
export function isEmptyPlan(plan: CleanPlan): boolean {
  return (
    plan.genres.length === 0 &&
    plan.keywords.length === 0 &&
    plan.people.length === 0 &&
    !plan.titleQuery
  );
}

/** Asks the model for a search plan. Null whenever the LLM route is unusable. */
export async function planMoodQuery(
  query: string,
  locale: 'en' | 'he',
): Promise<CleanPlan | null> {
  if (!llmAvailable()) return null;

  const plan = await completeStructured(MoodPlanSchema, {
    system: buildSystemPrompt(locale),
    user: query,
  });
  if (!plan) return null;

  const clean = sanitize(plan);
  return isEmptyPlan(clean) ? null : clean;
}

// ── Execution ──────────────────────────────────────────────────────────────

/** One failing TMDB call must not sink the whole resolution. */
function safe<T>(promise: Promise<T[]>): Promise<T[]> {
  return promise.catch(() => [] as T[]);
}

/** Which pass found a candidate — the primary ranking signal. */
type PlanSource = 'title' | 'keywordAll' | 'person' | 'keywordAny' | 'genre';

const SOURCE_WEIGHT: Record<PlanSource, number> = {
  title: 0.42,
  keywordAll: 0.36,
  person: 0.3,
  keywordAny: 0.22,
  genre: 0.08,
};

function scorePlanHit(
  draft: MediaDraft,
  plan: CleanPlan,
  sources: Set<PlanSource>,
): number {
  let value = 0.3;

  let best = 0;
  for (const source of sources) best = Math.max(best, SOURCE_WEIGHT[source]);
  value += best;
  // Corroboration across independent passes is real evidence.
  if (sources.size > 1) value += 0.07;

  if (plan.genres.length > 0) {
    const overlap = draft.genres.filter((g) => plan.genres.includes(g)).length;
    value += Math.min(overlap / plan.genres.length, 1) * 0.1;
  }
  if (plan.mediaType && draft.media_type === plan.mediaType) value += 0.04;
  if (draft.vote_average != null) value += Math.min(draft.vote_average / 10, 1) * 0.08;

  return Math.min(value, 0.99);
}

export interface PlanExecution {
  plan: CleanPlan;
  results: MoodResult[];
}

/**
 * Runs a plan against TMDB and ranks what comes back.
 *
 * Passes are independent and run in parallel; a title is scored by the
 * strongest pass that found it, plus a bonus if several agreed. Nothing here
 * has an unfiltered fallback — if the plan matches nothing, the honest answer
 * is no results.
 */
export async function executeMoodPlan(
  plan: CleanPlan,
  locale: 'en' | 'he',
  options: { relaxed?: boolean } = {},
): Promise<MoodResult[]> {
  // Vote floors, halved-and-then-some on the relaxed pass. These are the only
  // thing that changes between passes — the query itself is identical.
  const floors = options.relaxed
    ? { keywordAll: 5, keywordAny: 15, person: 5, genre: 40, genreRating: 5.5 }
    : { keywordAll: 20, keywordAny: 120, person: 20, genre: 300, genreRating: 6.5 };

  const types: MediaType[] = plan.mediaType ? [plan.mediaType] : ['movie', 'tv'];
  const byType = (run: (type: MediaType) => Promise<MediaDraft[]>) =>
    Promise.all(types.map(run)).then((pages) => pages.flat());

  // Resolve the model's words into TMDB ids. Keyword lookup is strict (exact
  // or whole-word only), so a keyword the model invented resolves to nothing
  // and quietly drops out rather than poisoning the query.
  const [keywordHits, peopleHits] = await Promise.all([
    Promise.all(plan.keywords.map((k) => safe(searchKeywords(k, 1)))),
    Promise.all(plan.people.map((p) => safe(searchPeople(p, 1)))),
  ]);

  const keywordIds = [...new Set(keywordHits.flat().map((k) => k.id))];
  const personIds = [...new Set(peopleHits.flat().map((p) => p.id))];

  const shared = {
    locale,
    page: 1,
    ...(plan.genres.length > 0 ? { genres: plan.genres } : {}),
    ...(plan.excludeGenres.length > 0 ? { excludeGenres: plan.excludeGenres } : {}),
    ...(plan.minRating != null ? { minRating: plan.minRating } : {}),
    ...(plan.yearFrom != null ? { yearFrom: plan.yearFrom } : {}),
    ...(plan.yearTo != null ? { yearTo: plan.yearTo } : {}),
  } as const;

  const [titleHits, keywordAll, keywordAny, personResults, genreHits] = await Promise.all([
    // 1. The user named something concrete. Verbatim lookup, highest weight.
    plan.titleQuery ? safe(searchMulti(plan.titleQuery, locale)) : Promise.resolve([]),

    // 2. Every concept at once. Precise; frequently empty, which is fine.
    keywordIds.length >= 2
      ? byType((type) =>
          safe(
            fetchDiscover(type, {
              ...shared,
              keywordIds: keywordIds.slice(0, 3),
              keywordMode: 'and',
              minVotes: floors.keywordAll,
            }),
          ),
        )
      : Promise.resolve<MediaDraft[]>([]),

    // 3. Any concept. The workhorse for vibe queries, where a title matching
    //    one of "heartbreak | breakup | divorce" is already a good answer.
    keywordIds.length > 0
      ? byType((type) =>
          safe(
            fetchDiscover(type, {
              ...shared,
              keywordIds,
              keywordMode: 'or',
              minVotes: floors.keywordAny,
              sortBy: 'popularity.desc',
            }),
          ),
        )
      : Promise.resolve<MediaDraft[]>([]),

    // 4. People. Movies only — /discover/tv ignores person filters entirely
    //    (see supportsPeopleFilter), and fetchDiscover fails closed for TV.
    personIds.length > 0
      ? safe(
          fetchDiscover('movie', {
            ...shared,
            castIds: personIds,
            sortBy: 'vote_count.desc',
            minVotes: floors.person,
          }),
        ).then(async (cast) => {
          if (cast.length > 0) return cast;
          // Not an actor in this catalogue — try them as a director.
          return safe(
            fetchDiscover('movie', {
              ...shared,
              crewIds: personIds,
              sortBy: 'vote_count.desc',
              minVotes: 20,
            }),
          );
        })
      : Promise.resolve<MediaDraft[]>([]),

    // 5. Genre backstop. Lowest weight, and quality-gated so it contributes
    //    plausible titles rather than whatever is merely popular this week.
    plan.genres.length > 0
      ? byType((type) =>
          safe(
            fetchDiscover(type, {
              ...shared,
              minVotes: floors.genre,
              minRating: plan.minRating ?? floors.genreRating,
              sortBy: 'vote_average.desc',
            }),
          ),
        )
      : Promise.resolve<MediaDraft[]>([]),
  ]);

  const found = new Map<string, { draft: MediaDraft; sources: Set<PlanSource> }>();
  const add = (draft: MediaDraft, source: PlanSource) => {
    if (plan.mediaType && draft.media_type !== plan.mediaType) return;
    const key = `${draft.media_type}:${draft.tmdb_id}`;
    const existing = found.get(key);
    if (existing) existing.sources.add(source);
    else found.set(key, { draft, sources: new Set([source]) });
  };

  for (const draft of titleHits) add(draft, 'title');
  for (const draft of keywordAll) add(draft, 'keywordAll');
  for (const draft of personResults) add(draft, 'person');
  for (const draft of keywordAny) add(draft, 'keywordAny');
  for (const draft of genreHits) add(draft, 'genre');

  return [...found.values()]
    .map((entry) => ({ entry, value: scorePlanHit(entry.draft, plan, entry.sources) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12)
    .map(({ entry, value }) => draftToResult(entry.draft, value));
}

/**
 * Full AI path: plan, then execute.
 * Null means "the AI route produced nothing" — the caller falls back.
 */
export async function resolveMoodWithLLM(
  query: string,
  locale: 'en' | 'he',
): Promise<PlanExecution | null> {
  const plan = await planMoodQuery(query, locale);
  if (!plan) {
    if (__DEV__) console.log('[mood] no usable plan from the model');
    return null;
  }
  if (__DEV__) console.log('[mood] plan:', JSON.stringify(plan));

  let results = await executeMoodPlan(plan, locale);

  /**
   * Second pass with the quality gates dropped.
   *
   * The first pass is deliberately strict — 300 votes and a 6.5 rating floor on
   * the genre backstop, 120 on keyword-any — because a mood search that returns
   * obscure junk is worse than one that returns little. But a GOOD plan can
   * legitimately clear nothing: niche keyword combinations, non-English
   * catalogues and recent titles all sit under those floors. Reporting "no
   * results" there blames the user's phrasing for our threshold.
   *
   * So: retry the same plan with the bar lowered rather than giving up. Still
   * the user's actual query — nothing unfiltered is substituted in.
   */
  if (results.length === 0) {
    if (__DEV__) console.log('[mood] strict pass empty — retrying relaxed');
    results = await executeMoodPlan({ ...plan, minRating: null }, locale, { relaxed: true });
  }

  if (results.length === 0) {
    if (__DEV__) console.log('[mood] relaxed pass empty too');
    return null;
  }

  return { plan, results };
}
