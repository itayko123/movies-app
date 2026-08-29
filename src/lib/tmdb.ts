import { z } from 'zod';
import { env } from '@/lib/env';
import type { MediaItemRow } from '@/types/media';

const BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/**
 * TMDB image sizes. Memory rule: the swipe deck must ALWAYS use 'w500'
 * (10 prefetched 'original' posters will OOM low-end Android devices);
 * 'w780'/'original' are reserved for the detail screen.
 */
export type TmdbImageSize = 'w185' | 'w342' | 'w500' | 'w780' | 'original';

export function imageUrl(path: string | null | undefined, size: TmdbImageSize): string | null {
  if (!path) return null;
  return `${IMAGE_BASE}/${size}${path}`;
}

export type MediaType = 'movie' | 'tv';

/**
 * THE canonical genre dictionary.
 *
 * TMDB uses two DIFFERENT id vocabularies, and they are not parallel:
 *   • Movies have Action(28), Adventure(12), Fantasy(14), Horror(27),
 *     Romance(10749), Thriller(53), War(10752), Sci-Fi(878).
 *   • TV folds several of those together — "Action & Adventure"(10759),
 *     "Sci-Fi & Fantasy"(10765), "War & Politics"(10768) — and has NO Horror,
 *     Romance or Thriller genre at all, plus a Kids(10762) bucket movies lack.
 *
 * Sending a movie id in a TV query does not error; TMDB just ignores it and
 * returns the unfiltered catalogue. That silent widening is what made the deck
 * look like it ignored the user's picks. One dictionary keyed by DISPLAY NAME,
 * holding the ids for each media type explicitly, makes the mismatch
 * impossible to reintroduce — and an empty array is a meaningful answer
 * meaning "this media type cannot express this category".
 */
export const GENRE_CATALOG = {
  Action: { movie: [28], tv: [10759] },
  Adventure: { movie: [12], tv: [10759] },
  Animation: { movie: [16], tv: [16] },
  Comedy: { movie: [35], tv: [35] },
  Crime: { movie: [80], tv: [80] },
  Documentary: { movie: [99], tv: [99] },
  Drama: { movie: [18], tv: [18] },
  Family: { movie: [10751], tv: [10751] },
  Fantasy: { movie: [14], tv: [10765] },
  History: { movie: [36], tv: [] },
  Horror: { movie: [27], tv: [] },
  /**
   * Kids & Youth deliberately does NOT include bare Animation (16).
   *
   * Verified against the live API: OR-ing Animation into this category returns
   * Rick and Morty, Family Guy and Demon Slayer at the top — animation is a
   * medium, not an audience. Family(10751) and Kids(10762) already carry
   * essentially all genuine children's animation (Toy Story, Zootopia,
   * Rugrats, PAW Patrol are tagged Family), so adding 16 only ever ADDS adult
   * titles. See KIDS_EXCLUDED_GENRES for the second safety net.
   */
  'Kids & Youth': { movie: [10751], tv: [10762, 10751] },
  Music: { movie: [10402], tv: [] },
  Mystery: { movie: [9648], tv: [9648] },
  Reality: { movie: [], tv: [10764] },
  Romance: { movie: [10749], tv: [] },
  'Science Fiction': { movie: [878], tv: [10765] },
  Thriller: { movie: [53], tv: [] },
  War: { movie: [10752], tv: [10768] },
  Western: { movie: [37], tv: [37] },
} as const satisfies Record<string, { movie: readonly number[]; tv: readonly number[] }>;

export type GenreName = keyof typeof GENRE_CATALOG;

// ── Regions ────────────────────────────────────────────────────────────────

/**
 * Top-level content regions.
 *
 * Region replaced the old "Israeli content" pseudo-genre. Modelling a country
 * as a genre was wrong on two counts: it made country and genre mutually
 * exclusive (you could not ask for "Korean thrillers"), and it had to be
 * smuggled past `with_genres` as a sentinel. This is an ORIGIN filter
 * (`with_origin_country`), a genuinely separate axis from both genre and from
 * `watch_region` (which only governs streaming availability).
 */
export const REGIONS = [
  { code: 'GLOBAL', flag: '🌍', label: 'Global', country: null, language: null },
  { code: 'IL', flag: '🇮🇱', label: 'Israel', country: 'IL', language: 'he' },
  { code: 'US', flag: '🇺🇸', label: 'USA', country: 'US', language: null },
  { code: 'KR', flag: '🇰🇷', label: 'Korea', country: 'KR', language: null },
  { code: 'ES', flag: '🇪🇸', label: 'Spain', country: 'ES', language: null },
  { code: 'TR', flag: '🇹🇷', label: 'Türkiye', country: 'TR', language: null },
] as const;

export type RegionCode = (typeof REGIONS)[number]['code'];

/** ISO country for a region, or null for Global (no origin constraint). */
export function regionCountry(code: RegionCode): string | null {
  return REGIONS.find((region) => region.code === code)?.country ?? null;
}

export function regionMeta(code: RegionCode): (typeof REGIONS)[number] {
  return REGIONS.find((region) => region.code === code) ?? REGIONS[0];
}

/**
 * Original-language constraint for a region, or null to leave it unconstrained.
 *
 * ── Why only Israel has one ────────────────────────────────────────────────
 * `with_origin_country=IL` alone returns 469 films / 58 shows, and a visible
 * slice of that is Israeli-PRODUCED but English-spoken — "Jeruzalem" (v656) and
 * "The English Teacher" (v249) both rank in the first page on vote count. To a
 * user who picked the Israeli flag those read as the filter not working.
 *
 * Adding `with_original_language=he` narrows it to 406 / 52 and the top of the
 * list becomes the actual Hebrew canon: Waltz with Bashir, Lebanon, Foxtrot,
 * The Band's Visit, Shtisel, Fauda, Hatufim. (Measured against the live API at
 * the IL vote floor of 5.)
 *
 * The other regions are deliberately left alone: nobody has measured whether
 * ko/es/tr behave the same way, and a country filter is the wider, safer net
 * until they have — language drops co-productions shot in another tongue.
 */
export function regionLanguage(code: RegionCode): string | null {
  return regionMeta(code).language;
}

/**
 * Vote floor per region.
 *
 * One global threshold cannot serve all of these. 80 votes is nothing in the US
 * catalogue (76,643 films) but excludes most of the Israeli one (469 films,
 * where even Waltz with Bashir sits near 1,000 and the median is far below 80).
 * Too high and a region reads as empty; too low and the US deck fills with
 * obscurities. These are calibrated against the real per-region totals.
 */
/**
 * Vote-count floor per region.
 *
 * ── Israel is 0, deliberately ──────────────────────────────────────────────
 * A floor is a quality proxy that only works where the catalogue is large and
 * globally rated. Israel is neither, and at the old floor of 5 it starved the
 * deck. Measured against the live API, Israeli TV with `with_original_language=he`:
 *
 *     floor 20 →   12 titles
 *     floor  5 →   52 titles     ← the old value
 *     floor  1 →  336 titles
 *     floor  0 → 1049 titles
 *
 * and once a genre is ALSO pinned — which is the normal case, since onboarding
 * asks for genres — floor 5 collapses to almost nothing: Action 6, Mystery 7,
 * Comedy 11. Six titles minus the ones already swiped is why the deck showed
 * the same handful of shows over and over.
 *
 * Dropping the floor does not drop quality here, because the query is sorted by
 * `vote_count.desc`: page 1 is still Tehran (362 votes), Fauda (259), Shtisel
 * (46). The unrated long tail sits around page 40 and is only ever reached by a
 * user who has already swiped through everything well known — which is exactly
 * when showing it beats showing nothing.
 *
 * The other regions keep their floors: their catalogues are big enough that a
 * floor costs nothing, and none of them has been measured the way Israel has.
 */
const REGION_MIN_VOTES: Record<RegionCode, number> = {
  GLOBAL: 80,
  IL: 0,
  US: 150,
  KR: 20,
  ES: 20,
  TR: 10,
};

export function regionMinVotes(code: RegionCode): number {
  return REGION_MIN_VOTES[code];
}

/** Category name for the kids/youth mode, used in a couple of guards. */
export const KIDS_CATEGORY = 'Kids & Youth';

/**
 * Genres never shown in Kids & Youth, even if a title is also tagged Family.
 * Cheap belt-and-braces on top of the narrowed genre set above.
 */
const KIDS_EXCLUDED_GENRES: Record<MediaType, number[]> = {
  movie: [27, 53, 80, 10752], // Horror, Thriller, Crime, War
  tv: [80, 10768], // Crime, War & Politics
};

/**
 * TMDB ids for one category and media type. Empty means unsupported —
 * callers MUST treat that as "skip this query", never "query without a filter".
 */
export function getTMDBGenreId(genreName: string, mediaType: MediaType): number[] {
  const entry = (GENRE_CATALOG as Record<string, { movie: readonly number[]; tv: readonly number[] }>)[
    genreName
  ];
  return entry ? [...entry[mediaType]] : [];
}

/**
 * Reverse lookup for labelling results: TMDB id → display name, per media type.
 * Built from the catalog so the two can never drift apart. Where several
 * categories share an id (TV 10759 is both Action and Adventure) the first
 * declared name wins, which keeps card labels stable.
 */
const ID_TO_NAME: Record<MediaType, Record<number, string>> = (() => {
  const movie: Record<number, string> = {};
  const tv: Record<number, string> = {};
  for (const [name, ids] of Object.entries(GENRE_CATALOG)) {
    // "Kids & Youth" is a composite convenience category, not a TMDB genre —
    // labelling a card "Kids & Youth" because it is animated would be wrong.
    if (name === 'Kids & Youth') continue;
    for (const id of ids.movie) if (!(id in movie)) movie[id] = name;
    for (const id of ids.tv) if (!(id in tv)) tv[id] = name;
  }
  return { movie, tv };
})();

/**
 * Categories offered in onboarding and the Discover filter bar.
 *
 * "Kids & Youth" leads: it is a mode, not a mood, and a parent handing over the
 * phone needs it to be the first thing they see rather than something buried
 * between Horror and Mystery.
 */
export const SELECTABLE_GENRES = [
  'Kids & Youth',
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'Horror',
  'Mystery',
  'Romance',
  'Science Fiction',
  'Thriller',
  'War',
  'Western',
] as const satisfies readonly GenreName[];

/**
 * Backdrop art representing each onboarding category, keyed by genre name.
 *
 * These are deliberately CURATED classics rather than a live "most popular in
 * this genre" lookup. Two reasons:
 *  1. Popularity collides — a single tentpole release is simultaneously the top
 *     Action, Adventure AND Fantasy title, so a live grid renders the same
 *     image three times and looks broken.
 *  2. A genre tile has to read instantly. A recognisable classic communicates
 *     "Western" or "Horror" in one glance; this week's chart-topper does not.
 *
 * The paths are TMDB CDN paths, so these are still remote images fetched at
 * runtime — nothing is bundled.
 */
export const GENRE_BACKDROPS: Record<string, string> = {
  Action: '/uT895WNwm0aIJRtGizcQhrejWUo.jpg', // Mad Max: Fury Road
  Adventure: '/zPACwR32amTNvzId9qyapCWXYDJ.jpg', // Raiders of the Lost Ark
  Animation: '/dyJvKsNs2KP8qQnAXbRwDjblViy.jpg', // Spirited Away
  Comedy: '/9udCLTxTFl28RxnK8Q05E154ZGa.jpg', // The Grand Budapest Hotel
  Crime: '/tSPT36ZKlP2WVHJLM4cQPLSzv3b.jpg', // The Godfather
  Documentary: '/z2uuQasY4gQJ8VDAFki746JWeQJ.jpg', // Free Solo
  Drama: '/66Kn4XWhkuPkJxOJyPEx4U2CUfN.jpg', // Forrest Gump
  Family: '/hGGC9gKo7CFE3fW07RA587e5kol.jpg', // Up
  Fantasy: '/mWDdRXTivGE7aaY2vo1Ie0PfCX5.jpg', // LOTR: The Fellowship of the Ring
  Horror: '/mmd1HnuvAzFc4iuVJcnBrhDNEKr.jpg', // The Shining
  'Kids & Youth': '/3Rfvhy1Nl6sSGJwyjb0QiZzZYlB.jpg', // Toy Story
  Mystery: '/i5H7zusQGsysGQ8i6P361Vnr0n2.jpg', // Se7en
  Romance: '/nlPCdZlHtRNcF6C9hzUH4ebmV1w.jpg', // La La Land
  'Science Fiction': '/gNdLJU9TxrpGx4dkZidjys3fyy0.jpg', // Blade Runner 2049
  Thriller: '/aYcnDyLMnpKce1FOYUpZrXtgUye.jpg', // The Silence of the Lambs
  War: '/bdD39MpSVhKjxarTxLSfX6baoMP.jpg', // Saving Private Ryan
  Western: '/x4biAVdPVCghBlsVIzB6NmbghIz.jpg', // The Good, the Bad and the Ugly
  Israeli: '/cMoiIk3tD6qshxccYRjjym7l5YV.jpg', // Waltz with Bashir
};

/**
 * TMDB genre ids matching the given category names for a media type.
 *
 * Returns an EMPTY array when nothing maps. Callers must treat that as "this
 * media type cannot satisfy the request" and skip the query — see fetchDiscover.
 */
export function genreIdsForNames(names: string[], mediaType: MediaType): number[] {
  const ids = new Set<number>();
  for (const name of names) {
    for (const id of getTMDBGenreId(name, mediaType)) ids.add(id);
  }
  return [...ids];
}

const ListItemSchema = z.object({
  id: z.number(),
  // Deliberately a loose string: /trending/all and /search/multi also return
  // `person` entries, and a strict enum would fail the whole page parse.
  // toDraft() drops anything that isn't a movie or a TV show.
  media_type: z.string().optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  original_title: z.string().optional(),
  original_name: z.string().optional(),
  overview: z.string().nullish(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
  genre_ids: z.array(z.number()).default([]),
  vote_average: z.number().nullish(),
  popularity: z.number().nullish(),
  release_date: z.string().nullish(),
  first_air_date: z.string().nullish(),
  origin_country: z.array(z.string()).optional(),
  original_language: z.string().nullish(),
  adult: z.boolean().optional(),
});

const ListResponseSchema = z.object({
  page: z.number(),
  total_pages: z.number(),
  results: z.array(ListItemSchema),
});

export interface MediaDraft {
  tmdb_id: number;
  media_type: MediaType;
  title: string;
  original_title: string | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  genres: string[];
  runtime_minutes: number | null;
  release_year: number | null;
  vote_average: number | null;
  popularity: number | null;
  origin_country: string[];
  /**
   * ISO-639-1 of the title's ORIGINAL language.
   *
   * Kept because `origin_country` is unreliable for classifying search hits:
   * TMDB populates it consistently for TV but frequently leaves it empty on
   * movie records, so a country-only "is this Israeli?" test silently misses
   * Israeli films. `original_language === 'he'` is the signal that actually
   * holds across both media types.
   */
  original_language?: string | null;
}

function toDraft(item: z.infer<typeof ListItemSchema>, fallbackType: MediaType): MediaDraft | null {
  const rawType = item.media_type ?? fallbackType;
  if (rawType !== 'movie' && rawType !== 'tv') return null;
  // Narrowed by the guard above; TS can't infer literals from a `string`.
  const mediaType = rawType as MediaType;
  const title = mediaType === 'movie' ? item.title : item.name;
  if (!title || !item.poster_path || item.adult) return null;

  const genreMap = ID_TO_NAME[mediaType];
  const date = mediaType === 'movie' ? item.release_date : item.first_air_date;
  const year = date ? Number.parseInt(date.slice(0, 4), 10) : Number.NaN;

  return {
    tmdb_id: item.id,
    media_type: mediaType,
    title,
    original_title:
      (mediaType === 'movie' ? item.original_title : item.original_name) ?? null,
    overview: item.overview ?? null,
    poster_path: item.poster_path ?? null,
    backdrop_path: item.backdrop_path ?? null,
    genres: item.genre_ids
      .map((id) => genreMap[id])
      .filter((g): g is string => Boolean(g)),
    runtime_minutes: null,
    release_year: Number.isNaN(year) ? null : year,
    vote_average: item.vote_average ?? null,
    popularity: item.popularity ?? null,
    origin_country: item.origin_country ?? [],
    original_language: item.original_language ?? null,
  };
}

async function tmdbFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${env.EXPO_PUBLIC_TMDB_TOKEN}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`TMDB ${path} failed with status ${res.status}`);
  }
  return res.json();
}

const TMDB_LOCALE: Record<'en' | 'he', string> = { en: 'en-US', he: 'he-IL' };

/**
 * The audience is Israeli, so every request is region-scoped to IL:
 *  - `region`       → release dates and certification are the Israeli ones
 *  - `watch_region` → streaming availability reflects Israeli services
 *
 * Combined with `language=he-IL` (when the app is in Hebrew) this returns
 * Hebrew titles/overviews and surfaces local cinema and TV instead of a purely
 * US-centric catalogue.
 */
export const TMDB_REGION = 'IL';

/** Params every request shares. */
function baseParams(locale: 'en' | 'he'): Record<string, string> {
  return {
    language: TMDB_LOCALE[locale],
    region: TMDB_REGION,
    watch_region: TMDB_REGION,
    include_adult: 'false',
  };
}

/**
 * Fetches a list and, in Hebrew, backfills whatever TMDB has no Hebrew
 * translation for.
 *
 * TMDB's `language` parameter is all-or-nothing per field: an untranslated
 * title comes back as the ORIGINAL (often Hebrew-transliterated or English)
 * and an untranslated overview comes back as an EMPTY STRING — not as the
 * English text. Israeli and long-tail catalogue entries are frequently only
 * partly translated, so a Hebrew-only request produces cards with blank
 * descriptions.
 *
 * So for `he` we run the same query twice, in parallel, and merge per field:
 * Hebrew wins wherever it exists, English fills the gaps. English requests are
 * untouched and still cost exactly one call.
 */
/**
 * A page of results plus how many pages exist.
 *
 * `totalPages` is load-bearing, not informational: it is the only way the deck
 * can know a constrained catalogue is EXHAUSTED. Israeli TV is 58 titles — 3
 * pages — and without this signal the deck kept incrementing the page number
 * forever, TMDB kept returning empty pages, and the deck backfilled with
 * whatever generic content was still buffered. That is the "asked for Israel,
 * got Troy" fallback pollution.
 */
export interface MediaPage {
  drafts: MediaDraft[];
  totalPages: number;
}

/**
 * Extra localization applied on top of the UI language.
 *
 * `titleLocale` requests titles in a language the UI is NOT set to. Israeli
 * content is the reason it exists: an Israeli film's real name is its Hebrew
 * one, and an English-language request returns TMDB's transliteration or a
 * translated title ("Ha-Buah" / "The Bubble" instead of "הבועה"). Showing a
 * local title in the wrong script is a worse answer than mixing scripts, so
 * origin-scoped requests pull the Hebrew TITLE while keeping the rest of the
 * payload in the UI language.
 */
export interface TitleLocaleOption {
  titleLocale?: 'he';
}

async function fetchLocalizedList(
  path: string,
  params: Record<string, string>,
  locale: 'en' | 'he',
  fallbackType: MediaType,
  options: TitleLocaleOption = {},
): Promise<MediaPage> {
  const parse = (raw: unknown, type: MediaType): MediaPage => {
    const data = ListResponseSchema.parse(raw);
    return {
      drafts: data.results
        .map((item) => toDraft(item, type))
        .filter((d): d is MediaDraft => d !== null),
      totalPages: data.total_pages,
    };
  };

  if (locale === 'en') {
    // English UI, Hebrew titles: English is the PRIMARY payload (overviews,
    // everything else) and Hebrew is overlaid onto the title field only.
    if (options.titleLocale === 'he') {
      const [englishPage, hebrewPage] = await Promise.all([
        tmdbFetch(path, { ...params, ...baseParams('en') }).then((raw) =>
          parse(raw, fallbackType),
        ),
        tmdbFetch(path, { ...params, ...baseParams('he') })
          .then((raw) => parse(raw, fallbackType))
          // A title overlay is an enhancement; never let it fail the request.
          .catch(() => ({ drafts: [], totalPages: 0 }) as MediaPage),
      ]);

      const hebrewTitles = new Map(
        hebrewPage.drafts.map((d) => [`${d.media_type}:${d.tmdb_id}`, d.title]),
      );
      return {
        totalPages: englishPage.totalPages,
        drafts: englishPage.drafts.map((draft) => {
          const hebrew = hebrewTitles.get(`${draft.media_type}:${draft.tmdb_id}`)?.trim();
          return hebrew ? { ...draft, title: hebrew } : draft;
        }),
      };
    }

    return parse(await tmdbFetch(path, { ...params, ...baseParams('en') }), fallbackType);
  }

  const [hebrewPage, englishPage] = await Promise.all([
    tmdbFetch(path, { ...params, ...baseParams('he') }).then((raw) => parse(raw, fallbackType)),
    tmdbFetch(path, { ...params, ...baseParams('en') })
      .then((raw) => parse(raw, fallbackType))
      // The fallback is a nicety; never let it fail the primary request.
      .catch(() => ({ drafts: [], totalPages: 0 }) as MediaPage),
  ]);

  const hebrew = hebrewPage.drafts;
  const english = englishPage.drafts;

  const byKey = new Map(english.map((d) => [`${d.media_type}:${d.tmdb_id}`, d]));
  return {
    totalPages: hebrewPage.totalPages,
    drafts: hebrew.map((draft) => {
      const fallback = byKey.get(`${draft.media_type}:${draft.tmdb_id}`);
      if (!fallback) return draft;
      return {
        ...draft,
        title: draft.title.trim() || fallback.title,
        overview: draft.overview?.trim() ? draft.overview : fallback.overview,
      };
    }),
  };
}

/** Trending movies + TV, localized and region-scoped. */
export async function fetchTrending(page: number, locale: 'en' | 'he'): Promise<MediaDraft[]> {
  const result = await fetchLocalizedList(
    '/trending/all/week',
    { page: String(page) },
    locale,
    'movie',
  );
  return result.drafts;
}

/**
 * Today's trending, as opposed to the week used for the deck.
 *
 * The community ticker falls back to this, and a ticker that says "today"
 * should not be showing the same seven titles all week.
 */
export async function fetchTrendingToday(locale: 'en' | 'he'): Promise<MediaDraft[]> {
  const result = await fetchLocalizedList(
    '/trending/all/day',
    { page: '1' },
    locale,
    'movie',
  );
  return result.drafts;
}

/**
 * Discover feed for ONE media type, filtered by the user's chosen genres.
 * Genres are OR-ed (`|`) so a broad taste profile doesn't starve the deck.
 */
export interface DiscoverOptions {
  page: number;
  locale: 'en' | 'he';
  genres?: string[];
  /** TMDB keyword ids. Drives the semantic mood matcher. */
  keywordIds?: number[];
  /**
   * 'and' requires every keyword (precise, can return nothing); 'or' is the
   * recall pass. The mood resolver runs both and ranks AND-hits higher.
   */
  keywordMode?: 'and' | 'or';
  /** Raise for "best of" surfaces like For You; lower for a broad deck. */
  minVotes?: number;
  sortBy?: string;
  /**
   * ISO country code constraint (`with_origin_country`). Driven by the region
   * switcher — a country filter, NOT a genre, so it travels on its own
   * parameter and composes with `with_genres`.
   */
  originCountry?: string;
  /**
   * ISO-639-1 spoken-language constraint (`with_original_language`).
   *
   * Composes with `originCountry` as an AND. See regionLanguage() for why the
   * two are used together for Israel rather than one standing in for the other.
   */
  originalLanguage?: string;
  /** Upper vote bound — pairs with minRating to surface Hidden Gems. */
  maxVotes?: number;
  /** `vote_average.gte`. */
  minRating?: number;
  /** Genre ids to exclude outright (`without_genres`). */
  excludeGenres?: string[];

  // ── Person filters (the taste vector's people half) ──────────────────────
  //
  // TMDB keeps these on three DIFFERENT parameters and they are not
  // interchangeable:
  //   • with_cast   — appears in front of the camera (movies only)
  //   • with_crew   — any crew credit, which is how directors are matched
  //   • with_people — cast OR crew, the union
  // TV discover supports NONE of them; `/discover/tv` silently ignores
  // with_cast/with_crew and returns the unfiltered catalogue, so callers must
  // check `supportsPeopleFilter` rather than send them and hope.
  /** Person ids matched against the cast list. */
  castIds?: number[];
  /**
   * Person ids matched against crew credits.
   *
   * KNOWN IMPRECISION: TMDB has no "director only" discover filter — `with_crew`
   * matches ANY crew credit. Querying Christopher Nolan returns Batman v
   * Superman, which he produced and co-wrote but did not direct. There is no
   * server-side way to narrow this; the only exact alternative is
   * `/person/{id}/movie_credits`, which cannot be combined with genre, rating
   * or year filters. The shelf is therefore labelled "More FROM {name}" rather
   * than "Directed by", which is true of every result it can return.
   */
  crewIds?: number[];

  /** `primary_release_date.gte` / `first_air_date.gte`, as a year. */
  yearFrom?: number;
  /** `primary_release_date.lte` / `first_air_date.lte`, as a year. */
  yearTo?: number;
}

/**
 * Whether `/discover/{type}` honours the person parameters.
 *
 * Only movies do. Verified against the live API: `/discover/tv?with_cast=…`
 * returns the same page as `/discover/tv` with no filter at all — a silent
 * widening of exactly the kind that made the deck look like it ignored the
 * user. Person-driven shelves are therefore movie-only by construction.
 */
export function supportsPeopleFilter(mediaType: MediaType): boolean {
  return mediaType === 'movie';
}

export async function fetchDiscover(
  mediaType: MediaType,
  options: DiscoverOptions,
): Promise<MediaDraft[]> {
  const result = await fetchDiscoverPage(mediaType, options);
  return result.drafts;
}

/**
 * Same as fetchDiscover but exposes `totalPages`, so a caller paging through a
 * constrained catalogue can tell exhaustion apart from a transient empty page.
 */
export async function fetchDiscoverPage(
  mediaType: MediaType,
  options: DiscoverOptions,
): Promise<MediaPage> {
  const genreIds = options.genres?.length
    ? genreIdsForNames(options.genres, mediaType)
    : [];

  // Requested genres that this media type cannot express. Running the query
  // anyway would drop `with_genres` and return the entire popular catalogue —
  // a strict filter must fail closed, not open. totalPages 0 tells the caller
  // this lane is permanently dry rather than merely empty on this page.
  if (options.genres?.length && genreIds.length === 0) {
    return { drafts: [], totalPages: 0 };
  }

  const params: Record<string, string> = {
    page: String(options.page),
    sort_by: options.sortBy ?? 'popularity.desc',
    // A country-scoped catalogue is small; the default threshold would empty it.
    'vote_count.gte': String(options.minVotes ?? (options.originCountry ? 10 : 80)),
  };
  if (genreIds.length > 0) params.with_genres = genreIds.join('|');

  // Applied here rather than at the call sites so every surface that can ask
  // for Kids & Youth — deck, filter bar, For You — is safe by construction.
  if (options.genres?.includes(KIDS_CATEGORY)) {
    params.without_genres = KIDS_EXCLUDED_GENRES[mediaType].join(',');
  }

  if (options.excludeGenres?.length) {
    const excluded = genreIdsForNames(options.excludeGenres, mediaType);
    if (excluded.length > 0) {
      params.without_genres = params.without_genres
        ? `${params.without_genres},${excluded.join(',')}`
        : excluded.join(',');
    }
  }

  if (options.keywordIds?.length) {
    params.with_keywords = options.keywordIds.join(options.keywordMode === 'and' ? ',' : '|');
  }
  if (options.originCountry) params.with_origin_country = options.originCountry;
  if (options.originalLanguage) params.with_original_language = options.originalLanguage;
  if (options.maxVotes != null) params['vote_count.lte'] = String(options.maxVotes);
  if (options.minRating != null) params['vote_average.gte'] = String(options.minRating);

  // Person filters. Guarded rather than sent optimistically — see
  // supportsPeopleFilter for why an unsupported one is worse than none.
  if (supportsPeopleFilter(mediaType)) {
    if (options.castIds?.length) params.with_cast = options.castIds.join('|');
    if (options.crewIds?.length) params.with_crew = options.crewIds.join('|');
  } else if (options.castIds?.length || options.crewIds?.length) {
    // Fail closed: the caller asked for a person constraint this media type
    // cannot express, so return nothing rather than the whole catalogue.
    return { drafts: [], totalPages: 0 };
  }

  const dateField = mediaType === 'movie' ? 'primary_release_date' : 'first_air_date';
  if (options.yearFrom != null) params[`${dateField}.gte`] = `${options.yearFrom}-01-01`;
  if (options.yearTo != null) params[`${dateField}.lte`] = `${options.yearTo}-12-31`;

  return fetchLocalizedList(`/discover/${mediaType}`, params, options.locale, mediaType, {
    // An Israeli title's real name is its Hebrew one. Requesting it whenever
    // the query is origin-scoped to IL means local content reads correctly even
    // with the app in English — see TitleLocaleOption.
    titleLocale: options.originCountry === TMDB_REGION ? 'he' : undefined,
  });
}

const KeywordResponseSchema = z.object({
  results: z.array(z.object({ id: z.number(), name: z.string() })),
});

export interface TmdbKeyword {
  id: number;
  name: string;
}

/**
 * Resolves a term the USER actually typed to TMDB keyword ids.
 *
 * TMDB curates keywords per title, so "a boy having adventures with his
 * grandpa" can be answered by discovering titles tagged `grandfather` +
 * `adventure` — something plain full-text search, which only matches words in
 * titles and overviews, cannot do.
 *
 * Matching is deliberately strict. TMDB's keyword index is fuzzy and will
 * happily answer "hackers" with "hawkers"; accepting that would attach
 * confident-looking but wrong results to a query. Only an exact match or a
 * whole-word containment counts.
 */
export async function searchKeywords(term: string, limit = 2): Promise<TmdbKeyword[]> {
  const data = KeywordResponseSchema.parse(
    await tmdbFetch('/search/keyword', { query: term, page: '1' }),
  );
  const wanted = term.toLowerCase().trim();
  const wholeWord = new RegExp(`(^|\\s)${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);

  const rank = (name: string): number => {
    const lower = name.toLowerCase();
    if (lower === wanted) return 0;
    if (wholeWord.test(lower)) return 1;
    return 2;
  };

  return data.results
    .map((keyword) => ({ keyword, rank: rank(keyword.name) }))
    // Rank 2 is a fuzzy near-miss ("hawkers" for "hackers") — drop it entirely.
    .filter((entry) => entry.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.keyword.name.length - b.keyword.name.length)
    .slice(0, limit)
    .map((entry) => entry.keyword);
}

// ── People ─────────────────────────────────────────────────────────────────

export interface TmdbPerson {
  id: number;
  name: string;
  profile_path: string | null;
}

const PersonSearchSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        profile_path: z.string().nullish(),
        popularity: z.number().nullish(),
        known_for_department: z.string().nullish(),
      }),
    )
    .default([]),
});

/**
 * Resolves a person's NAME to a TMDB id.
 *
 * Needed because the LLM planner and the user both speak in names, while
 * `/discover` only accepts ids. Results are popularity-ordered by TMDB, which
 * is the right tiebreak here: "Ryan Reynolds" should resolve to the actor, not
 * to a namesake camera operator.
 */
export async function searchPeople(name: string, limit = 1): Promise<TmdbPerson[]> {
  const data = PersonSearchSchema.parse(
    await tmdbFetch('/search/person', { query: name, page: '1' }),
  );
  const wanted = name.toLowerCase().trim();
  return data.results
    // An exact name match outranks a merely popular near-match.
    .sort((a, b) => {
      const exact = Number(b.name.toLowerCase() === wanted) - Number(a.name.toLowerCase() === wanted);
      return exact !== 0 ? exact : (b.popularity ?? 0) - (a.popularity ?? 0);
    })
    .slice(0, limit)
    .map((p) => ({ id: p.id, name: p.name, profile_path: p.profile_path ?? null }));
}

/** A person plus the department TMDB best associates them with. */
export interface TmdbPopularPerson extends TmdbPerson {
  /** 'Acting' | 'Directing' | … — used to pick the right discover parameter. */
  department: string;
}

const PopularPeopleSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        profile_path: z.string().nullish(),
        known_for_department: z.string().nullish(),
        adult: z.boolean().optional(),
        known_for: z
          .array(z.object({ vote_count: z.number().nullish() }))
          .default([]),
      }),
    )
    .default([]),
});

/**
 * How many votes one of a person's best-known titles must have before we are
 * willing to put their face on the home screen.
 *
 * TMDB's `popularity` score is a short-window traffic signal, not a measure of
 * renown, and the raw top of `/person/popular` is genuinely noisy — a live call
 * returned Tom Holland and Jason Statham next to two people with no
 * recognisable credits at all. Scoring on the vote count of their KNOWN WORK is
 * the check that separates the two, because it asks a question about the films
 * rather than about this week's clicks.
 */
const POPULAR_PERSON_MIN_VOTES = 500;

/**
 * Globally popular people, for the Discover "people" row's COLD START.
 *
 * A brand-new account has an empty person vector, and hiding the row until the
 * user has swiped enough to fill it leaves the most important first impression
 * looking half-built. This fills the same shelf with real, current names.
 *
 * Only people TMDB can illustrate are returned: a row of blank initial-discs
 * would be worse than no row. Restricted to Acting and Directing because those
 * are the only two departments `/discover` can actually filter on — offering a
 * costume designer would lead to an empty results page.
 */
export async function fetchPopularPeople(
  locale: 'en' | 'he',
  limit = 8,
): Promise<TmdbPopularPerson[]> {
  const data = PopularPeopleSchema.parse(
    await tmdbFetch('/person/popular', { page: '1', language: TMDB_LOCALE[locale] }),
  );
  return data.results
    .filter((person) => !person.adult)
    // A row of blank initial-discs would be worse than no row.
    .filter((person) => Boolean(person.profile_path))
    // Acting and Directing are the only departments `/discover` can filter on,
    // so anyone else would lead to an empty results page.
    .filter((person) => {
      const department = person.known_for_department ?? '';
      return department === 'Acting' || department === 'Directing';
    })
    // Renown, judged by their work rather than by this week's traffic.
    .map((person) => ({
      person,
      bestKnown: Math.max(0, ...person.known_for.map((title) => title.vote_count ?? 0)),
    }))
    .filter((entry) => entry.bestKnown >= POPULAR_PERSON_MIN_VOTES)
    // RANK by that evidence too, not just gate on it. Keeping TMDB's own order
    // left the front of the row recognisable and the tail full of people with
    // one credit in one big film — the gate proves someone was in something
    // known, the sort is what puts the household names first.
    .sort((a, b) => b.bestKnown - a.bestKnown)
    .slice(0, limit)
    .map(({ person }) => ({
      id: person.id,
      name: person.name,
      profile_path: person.profile_path ?? null,
      department: person.known_for_department ?? 'Acting',
    }));
}

const CreditsSchema = z.object({
  cast: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        profile_path: z.string().nullish(),
        order: z.number().nullish(),
      }),
    )
    .default([]),
  crew: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        job: z.string().nullish(),
        profile_path: z.string().nullish(),
      }),
    )
    .default([]),
});

/** The authorship signal for one title: who made it and who is in it. */
export interface TitleCredits {
  /**
   * The director, or for TV the creator/executive producer.
   *
   * TV credits have no "Director" job on the series-level endpoint (episodes
   * each have their own), so `/tv/{id}/credits` crew is mostly producers. The
   * series creator is the equivalent authorial signal and is read from the
   * aggregate `created_by` field instead.
   */
  director: TmdbPerson | null;
  /** Top-billed cast, in billing order, capped by the caller. */
  cast: TmdbPerson[];
}

const CreatedBySchema = z.object({
  created_by: z
    .array(z.object({ id: z.number(), name: z.string(), profile_path: z.string().nullish() }))
    .default([]),
});

/** How many billed actors count as "the cast" for taste purposes. */
export const TASTE_CAST_DEPTH = 3;

/**
 * Director + top-billed cast for one title.
 *
 * Deliberately tolerant: any failure resolves to empty credits rather than
 * throwing, because this feeds a background learning pass that must never be
 * able to break a swipe.
 */
export async function fetchTitleCredits(
  tmdbId: number,
  mediaType: MediaType,
): Promise<TitleCredits> {
  const empty: TitleCredits = { director: null, cast: [] };
  try {
    const raw = await tmdbFetch(`/${mediaType}/${tmdbId}`, {
      append_to_response: 'credits',
      language: TMDB_LOCALE.en,
    });
    const credits = CreditsSchema.safeParse(
      (raw as { credits?: unknown } | null)?.credits ?? {},
    );
    if (!credits.success) return empty;

    const cast = credits.data.cast
      .slice()
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
      .slice(0, TASTE_CAST_DEPTH)
      .map((c) => ({ id: c.id, name: c.name, profile_path: c.profile_path ?? null }));

    let director: TmdbPerson | null = null;
    if (mediaType === 'movie') {
      const found = credits.data.crew.find((c) => c.job === 'Director');
      if (found) {
        director = { id: found.id, name: found.name, profile_path: found.profile_path ?? null };
      }
    } else {
      const creators = CreatedBySchema.safeParse(raw);
      const found = creators.success ? creators.data.created_by[0] : undefined;
      if (found) {
        director = { id: found.id, name: found.name, profile_path: found.profile_path ?? null };
      }
    }

    return { director, cast };
  } catch {
    return empty;
  }
}

/**
 * Free-text search across movies and TV — powers the mood matcher's
 * "about hackers"-style topical part of a query.
 */
export async function searchMulti(
  query: string,
  locale: 'en' | 'he',
  page = 1,
): Promise<MediaDraft[]> {
  const result = await fetchLocalizedList(
    '/search/multi',
    { query, page: String(page) },
    locale,
    'movie',
  );
  return result.drafts;
}

/** Which slice of the catalogue a text search should return. */
export type SearchScope = 'all' | 'israeli' | 'international';

/**
 * True when a title is Israeli.
 *
 * Checks BOTH signals rather than picking one, because each has a blind spot:
 * `original_language` misses an Israeli co-production shot in English or
 * Arabic, and `origin_country` is frequently absent on TMDB movie records.
 * Together they catch the cases either one alone would drop.
 */
export function isIsraeliTitle(draft: MediaDraft): boolean {
  return draft.original_language === 'he' || draft.origin_country.includes('IL');
}

/**
 * Text search, narrowed to one slice of the catalogue.
 *
 * ── Why the filtering happens here and not at TMDB ─────────────────────────
 * `/search/*` accepts no language or country parameter — `with_original_language`
 * and `with_origin_country` are DISCOVER-only, and discover accepts no text
 * query. There is no single endpoint that does "Israeli titles matching this
 * text", so the partition has to be done on the results.
 *
 * ── Why it pages until it fills ────────────────────────────────────────────
 * Naively filtering one page is the trap: Israeli titles are a thin slice of a
 * global index, so a search for a common word can return twenty international
 * hits on page 1 and leave the Israeli tab looking empty when matches exist on
 * page 2. This walks pages until it has enough or the results run out, capped
 * so a query with no Israeli matches at all terminates quickly instead of
 * crawling the whole result set.
 */
export async function searchByScope(
  query: string,
  locale: 'en' | 'he',
  scope: SearchScope,
  limit = 40,
): Promise<MediaDraft[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const MAX_PAGES = scope === 'all' ? 1 : 4;
  const seen = new Set<string>();
  const out: MediaDraft[] = [];

  for (let page = 1; page <= MAX_PAGES && out.length < limit; page += 1) {
    let drafts: MediaDraft[];
    try {
      drafts = await searchMulti(trimmed, locale, page);
    } catch {
      break; // Keep whatever we already have rather than failing the search.
    }
    if (drafts.length === 0) break;

    for (const draft of drafts) {
      const key = `${draft.media_type}:${draft.tmdb_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const israeli = isIsraeliTitle(draft);
      if (scope === 'israeli' && !israeli) continue;
      if (scope === 'international' && israeli) continue;

      // A result with no poster reads as a broken cell in a poster grid, and
      // TMDB search returns plenty of them for obscure entries.
      if (!draft.poster_path) continue;

      out.push(draft);
      if (out.length >= limit) break;
    }
  }

  return out;
}

/**
 * The best-known output of one country.
 *
 * Two decisions here were verified against the live API rather than assumed:
 *
 * 1. **`sort_by=vote_count.desc`, not `popularity.desc`.** TMDB's popularity
 *    score is a short-window trending signal. Across a national catalogue it is
 *    almost pure noise: sorting Israeli films by popularity surfaced "In Bed"
 *    and "The Dress" (5–7 votes) above Waltz with Bashir (1,068). Vote count is
 *    the stable proxy for "actually well known", and it returns the canon —
 *    Tehran, Fauda, Shtisel for IL; Parasite, Squid Game for KR; Money Heist,
 *    Pan's Labyrinth for ES.
 *
 * 2. **`with_origin_country`, not `with_original_language`.** Language drops
 *    co-productions shot in another tongue while the country filter still
 *    catches the native-language ones, so it is the wider net of the two.
 *
 * Caveat worth knowing: some big domestic hits (Kupa Rashit, Taagud) carry
 * almost no TMDB votes because TMDB's audience is international. They exist in
 * the catalogue but rank low by any global metric — a data limit, not a bug.
 */
export async function fetchRegionalContent(
  mediaType: MediaType,
  options: {
    page: number;
    locale: 'en' | 'he';
    region: RegionCode;
    minVotes?: number;
  },
): Promise<MediaDraft[]> {
  const country = regionCountry(options.region);
  if (!country) return [];
  return fetchDiscover(mediaType, {
    page: options.page,
    locale: options.locale,
    originCountry: country,
    originalLanguage: regionLanguage(options.region) ?? undefined,
    sortBy: 'vote_count.desc',
    minVotes: options.minVotes ?? regionMinVotes(options.region),
  });
}

/** Both formats at once, film and television interleaved. */
export async function fetchRegionalPicks(
  page: number,
  locale: 'en' | 'he',
  region: RegionCode,
): Promise<MediaDraft[]> {
  const [movies, tv] = await Promise.all([
    fetchRegionalContent('movie', { page, locale, region }).catch(() => [] as MediaDraft[]),
    fetchRegionalContent('tv', { page, locale, region }).catch(() => [] as MediaDraft[]),
  ]);
  const out: MediaDraft[] = [];
  for (let i = 0; i < Math.max(movies.length, tv.length); i++) {
    const show = tv[i];
    const film = movies[i];
    // Series first: a country's flagship series is usually its strongest hook.
    if (show) out.push(show);
    if (film) out.push(film);
  }
  return out;
}

// ── Detail (runtime, cast, streaming providers) ────────────────────────────

const ProviderSchema = z.object({
  provider_id: z.number(),
  provider_name: z.string(),
  logo_path: z.string().nullish(),
});

const CountryProvidersSchema = z.object({
  link: z.string().optional(),
  flatrate: z.array(ProviderSchema).optional(),
  rent: z.array(ProviderSchema).optional(),
  buy: z.array(ProviderSchema).optional(),
});

const DetailSchema = z.object({
  id: z.number(),
  title: z.string().optional(),
  name: z.string().optional(),
  overview: z.string().nullish(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
  runtime: z.number().nullish(),
  episode_run_time: z.array(z.number()).optional(),
  number_of_seasons: z.number().optional(),
  genres: z.array(z.object({ id: z.number(), name: z.string() })).default([]),
  vote_average: z.number().nullish(),
  vote_count: z.number().nullish(),
  release_date: z.string().nullish(),
  first_air_date: z.string().nullish(),
  tagline: z.string().nullish(),
  credits: z
    .object({
      cast: z
        .array(
          z.object({
            id: z.number(),
            name: z.string(),
            character: z.string().nullish(),
            profile_path: z.string().nullish(),
          }),
        )
        .default([]),
    })
    .optional(),
  'watch/providers': z
    .object({ results: z.record(CountryProvidersSchema) })
    .optional(),
  production_companies: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        logo_path: z.string().nullish(),
      }),
    )
    .default([]),
  // Movies return `keywords.keywords`; TV returns `keywords.results`.
  keywords: z
    .object({
      keywords: z.array(z.object({ id: z.number(), name: z.string() })).optional(),
      results: z.array(z.object({ id: z.number(), name: z.string() })).optional(),
    })
    .optional(),
});

export type StreamingProvider = z.infer<typeof ProviderSchema>;

export interface MediaDetail {
  tmdb_id: number;
  title: string;
  overview: string | null;
  tagline: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  runtime_minutes: number | null;
  number_of_seasons: number | null;
  /**
   * LOCALISED genre names, straight from TMDB in the request language. For
   * DISPLAY only — under he-IL these come back as Hebrew.
   */
  genres: string[];
  /**
   * CANONICAL English genre names, resolved from TMDB's genre IDS through
   * ID_TO_NAME — the same map the deck's own `toDraft` uses.
   *
   * This exists because `genres` above is a TRANSLATION and the taste engine
   * keys on IDENTITY: `genreWeights`, `GENRE_CATALOG` and every
   * `with_genres` query use the English name. A localised string written into
   * a library entry becomes a key nothing can ever match — not an error
   * anywhere, it just accumulates as dead weight and splits one genre's
   * evidence across two spellings. The contract is stated in
   * src/i18n/genres.ts: store the English key, translate at render.
   */
  genre_keys: string[];
  vote_average: number | null;
  vote_count: number | null;
  release_year: number | null;
  cast: Array<{ id: number; name: string; character: string | null; profile_path: string | null }>;
  production: Array<{ id: number; name: string; logo_path: string | null }>;
  keywords: Array<{ id: number; name: string }>;
  providers: {
    link: string | null;
    flatrate: StreamingProvider[];
    rent: StreamingProvider[];
    buy: StreamingProvider[];
  };
}

/**
 * Full detail payload. `countryCode` drives real-time streaming availability
 * (TMDB's watch/providers is licensed JustWatch data).
 */
/**
 * Just the display name of a title.
 *
 * `fetchMediaDetail` appends credits and watch providers, which is three
 * joins' worth of payload for something like the community ticker that only
 * needs a string. Returns null rather than throwing: a label that cannot be
 * resolved should drop out of the list quietly, not fail the whole request.
 */
/**
 * Builds a deck row straight from a TMDB result.
 *
 * The Run 4 schema keys everything on `(media_id, media_type)`, so a title
 * needs no server round trip and no database uuid before it can be shown or
 * swiped. `id` keeps its historical `mock-` prefix purely so that libraries
 * persisted by earlier builds still match on the same key — the store is keyed
 * by `item.id`, and changing the format would strand every saved title.
 */
export function localMediaRow(draft: MediaDraft): MediaItemRow {
  return {
    id: `mock-${draft.media_type}-${draft.tmdb_id}`,
    tmdb_id: draft.tmdb_id,
    media_type: draft.media_type,
    title: draft.title,
    original_title: draft.original_title,
    overview: draft.overview,
    poster_path: draft.poster_path,
    backdrop_path: draft.backdrop_path,
    genres: draft.genres,
    runtime_minutes: draft.runtime_minutes,
    release_year: draft.release_year,
    vote_average: draft.vote_average,
    popularity: draft.popularity,
    origin_country: draft.origin_country,
  };
}

export async function fetchTitleName(
  tmdbId: number,
  mediaType: MediaType,
  locale: 'en' | 'he',
): Promise<string | null> {
  try {
    const raw = (await tmdbFetch(`/${mediaType}/${tmdbId}`, {
      language: TMDB_LOCALE[locale],
    })) as { title?: string; name?: string } | null;
    const title = raw?.title ?? raw?.name ?? null;
    return title && title.trim().length > 0 ? title : null;
  } catch {
    return null;
  }
}

export async function fetchMediaDetail(
  tmdbId: number,
  mediaType: MediaType,
  locale: 'en' | 'he',
  countryCode: string,
): Promise<MediaDetail> {
  const [raw, fallbackRaw] = await Promise.all([
    tmdbFetch(`/${mediaType}/${tmdbId}`, {
      language: TMDB_LOCALE[locale],
      append_to_response: 'credits,watch/providers,keywords',
    }),
    // Same Hebrew-coverage problem as the list endpoints: an untranslated
    // overview comes back as "" rather than as the English text.
    locale === 'he'
      ? tmdbFetch(`/${mediaType}/${tmdbId}`, { language: TMDB_LOCALE.en }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const data = DetailSchema.parse(raw);
  const fallback = fallbackRaw ? DetailSchema.safeParse(fallbackRaw) : null;
  const englishText = fallback?.success ? fallback.data : null;

  // Providers fall back to IL (the app's home region) before US.
  const byCountry = data['watch/providers']?.results ?? {};
  const country =
    byCountry[countryCode.toUpperCase()] ??
    byCountry[TMDB_REGION] ??
    byCountry['US'] ??
    {};

  return {
    tmdb_id: data.id,
    title:
      (mediaType === 'movie' ? data.title : data.name)?.trim() ||
      (mediaType === 'movie' ? englishText?.title : englishText?.name) ||
      'Untitled',
    overview: data.overview?.trim() || englishText?.overview || null,
    tagline: data.tagline?.trim() || englishText?.tagline || null,
    poster_path: data.poster_path ?? null,
    backdrop_path: data.backdrop_path ?? null,
    runtime_minutes: data.runtime ?? data.episode_run_time?.[0] ?? null,
    number_of_seasons: data.number_of_seasons ?? null,
    genres: data.genres.map((g) => g.name),
    // Resolved from IDS, never from names — the names arrive translated.
    // Genres outside our catalogue (TMDB's "TV Movie") drop out rather than
    // entering the taste vector as a key nothing can query.
    genre_keys: data.genres
      .map((g) => ID_TO_NAME[mediaType][g.id])
      .filter((name): name is string => Boolean(name)),
    vote_average: data.vote_average ?? null,
    vote_count: data.vote_count ?? null,
    release_year: (() => {
      const date = data.release_date ?? data.first_air_date ?? null;
      const year = date ? Number.parseInt(date.slice(0, 4), 10) : Number.NaN;
      return Number.isNaN(year) ? null : year;
    })(),
    cast: (data.credits?.cast ?? []).slice(0, 12).map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character ?? null,
      profile_path: c.profile_path ?? null,
    })),
    production: data.production_companies.map((company) => ({
      id: company.id,
      name: company.name,
      logo_path: company.logo_path ?? null,
    })),
    // Keywords are what the reference app shows as its chip cloud. TMDB only
    // ever returns them in the original language, so there is no he-IL
    // fallback to attempt here.
    keywords: data.keywords?.keywords ?? data.keywords?.results ?? [],
    providers: {
      link: country.link ?? null,
      flatrate: country.flatrate ?? [],
      rent: country.rent ?? [],
      buy: country.buy ?? [],
    },
  };
}

const ImagesSchema = z.object({
  posters: z
    .array(z.object({ file_path: z.string(), vote_count: z.number().nullish() }))
    .default([]),
  backdrops: z
    .array(z.object({ file_path: z.string(), vote_count: z.number().nullish() }))
    .default([]),
});

export interface MediaImages {
  /** Poster file_paths, best-voted first. */
  posters: string[];
  /** Backdrop file_paths, best-voted first. */
  backdrops: string[];
}

/**
 * Every poster and backdrop TMDB has for a title, across ALL languages —
 * the reference app's gallery shows the full international set, which is
 * exactly what makes it feel exhaustive. No `language` filter on purpose.
 * Sorted by community vote count so the strongest art leads the strip.
 */
export async function fetchMediaImages(
  tmdbId: number,
  mediaType: MediaType,
): Promise<MediaImages> {
  const raw = await tmdbFetch(`/${mediaType}/${tmdbId}/images`);
  const data = ImagesSchema.parse(raw);
  const rank = (arr: Array<{ file_path: string; vote_count?: number | null }>) =>
    [...arr]
      .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
      .map((image) => image.file_path);
  return { posters: rank(data.posters), backdrops: rank(data.backdrops) };
}
