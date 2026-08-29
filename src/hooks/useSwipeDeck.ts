import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import {
  fetchTrending,
  fetchDiscoverPage,
  imageUrl,
  regionCountry,
  regionLanguage,
  regionMinVotes,
  localMediaRow,
  type MediaDraft,
  type MediaType,
  type RegionCode,
} from '@/lib/tmdb';
import { invokeFunction } from '@/lib/functions';
import { learnTitleCredits } from '@/lib/taste';
import { safeFireAndForget } from '@/lib/safeNative';
import { prefetchPalettes } from '@/hooks/usePosterPalette';
import {
  useAppStore,
  selectTopGenres,
  TASTE_TAKEOVER_SWIPES,
  type MediaFormat,
} from '@/state/store';
import { type MediaItemRow, type SwipeDirection } from '@/types/media';
// TODO: MOCK AUTH - REMOVE BEFORE PRODUCTION
import { MOCK_AUTH_ENABLED } from '@/lib/devMock';
import { cloudReady } from '@/lib/cloudSync';

/**
 * Deck cards always use w500 posters. Prefetching ten `original` posters
 * (2–4 MB each, decoded to far more in memory) reliably OOMs low-end Android
 * devices — full-resolution art is loaded only on the detail screen.
 */
export const DECK_POSTER_SIZE = 'w500' as const;

/**
 * Keep at least this many cards buffered ahead of the top card.
 *
 * Sized against RAPID swiping, not comfortable swiping: a page takes roughly
 * half a second to land, and a determined user clears a card every ~250ms, so
 * a shallow buffer empties faster than it refills and the deck bottoms out
 * into an empty state that is not true.
 */
const MIN_BUFFER = 24;
const PAGE_SIZE_TARGET = 20;

/** Posters warmed ahead of the top card, so a promotion is never a network wait. */
const PREFETCH_DEPTH = 12;

/**
 * Unique titles a constrained region should reach before the deck settles for
 * what it has, and how many extra TMDB pages may be spent getting there.
 *
 * The cap matters as much as the target: a genuinely exhausted catalogue must
 * reach its honest end state quickly rather than spending a dozen requests
 * proving there is nothing left.
 */
const DEEP_POOL_TARGET = 110;
const DEEP_POOL_MAX_EXTRA_PAGES = 8;

/**
 * Cards mounted at once: the active card, the one visibly behind it, and a
 * third held at zero opacity.
 *
 * The third is not decoration — it exists so its poster is already decoded when
 * it is promoted. `Image.prefetch` warms the cache but does not decode, so with
 * only two cards mounted the third card's artwork was decoded during the frame
 * it first appeared, which is what shows up as a flash on rapid swipes.
 */
const VISIBLE_COUNT = 3;

export interface DeckPage {
  items: MediaItemRow[];
  nextPage: number | null;
}

/** The resolved query the deck is currently running. */
export interface DeckQuery {
  format: MediaFormat;
  /** Genre names pushed into TMDB's `with_genres`. */
  genres: string[];
  /** Content origin. Never relaxed, even when the catalogue runs dry. */
  region: RegionCode;
  /** Where those genres came from — surfaced in the UI. */
  source: 'pinned' | 'taste' | 'onboarding' | 'region' | 'trending';
  /**
   * True when the user made an explicit choice. Strict queries NEVER mix in
   * trending or any other unfiltered content: every single card must satisfy
   * the constraint, starting with card #1.
   */
  strict: boolean;
}

/**
 * Resolves what the deck should fetch right now.
 *
 * ── Absolute rules ─────────────────────────────────────────────────────────
 * 1. **Region is never relaxed.** It applies to every branch below, including
 *    the cold-start one. If the region's catalogue is exhausted the deck ends;
 *    it does not widen to keep cards flowing.
 * 2. **An explicit genre pick is a permanent hard constraint.** The learned
 *    taste profile re-ranks WITHIN the chosen genres and can never add one.
 *    Previously taste took over after 12 swipes and could introduce genres the
 *    user never asked for — pick War, swipe a few war films that are also
 *    tagged Drama/Family, and Family could enter the query. That is the
 *    mechanism behind "I chose War and got Toy Story".
 */
export function resolveDeckQuery(
  preferences: { genres: string[]; mediaType: MediaFormat } | null,
  filters: { format: MediaFormat | null; genre: string | null },
  topGenres: string[],
  tasteSwipeCount: number,
  region: RegionCode,
): DeckQuery {
  const format: MediaFormat = filters.format ?? preferences?.mediaType ?? 'both';
  const regionPinned = regionCountry(region) !== null;

  if (filters.genre) {
    // A pinned pill is the most explicit instruction there is — genre only.
    return { format, genres: [filters.genre], region, source: 'pinned', strict: true };
  }

  const chosen = preferences?.genres ?? [];

  if (chosen.length > 0) {
    // Taste may only REORDER the user's own genres, never extend them.
    const ranked = tasteSwipeCount >= TASTE_TAKEOVER_SWIPES
      ? [...chosen].sort(
          (a, b) => topGenres.indexOf(a) - topGenres.indexOf(b),
        )
      : chosen;
    return {
      format,
      genres: ranked,
      region,
      source: tasteSwipeCount >= TASTE_TAKEOVER_SWIPES ? 'taste' : 'onboarding',
      strict: true,
    };
  }

  // No genre chosen. Taste can propose genres here — the user expressed no
  // constraint to violate.
  if (topGenres.length > 0) {
    return { format, genres: topGenres, region, source: 'taste', strict: true };
  }

  // A region on its own is still a hard constraint, so this stays strict.
  if (regionPinned) {
    return { format, genres: [], region, source: 'region', strict: true };
  }

  // Nothing to go on at all — only here is unfiltered content acceptable.
  return { format, genres: [], region, source: 'trending', strict: false };
}

/** Interleaves two lists so the deck alternates instead of clustering. */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i];
    const right = b[i];
    if (left) out.push(left);
    if (right) out.push(right);
  }
  return out;
}

/**
 * Takes one item from each list in turn until all are drained.
 *
 * This is what guarantees the deck visibly honours EVERY chosen category from
 * the very first cards. OR-ing all genres into a single popularity-sorted
 * query does not: the union is then dominated by whichever blockbuster is
 * biggest overall, so picking "War + Animation" showed a wall of animation
 * hits and no war films — indistinguishable from the app ignoring the choice.
 */
function roundRobin<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item) out.push(item);
    }
  }
  return out;
}

/** Chosen categories fetched per page. Beyond this the deck rotates slowly. */
const MAX_LANES = 4;

/**
 * Builds one deck page for the resolved query.
 *
 * Strict queries fetch ONE LANE PER CHOSEN CATEGORY and round-robin them, so
 * card #1 is the top of the first category, card #2 the top of the second, and
 * so on. Nothing unfiltered is ever mixed in.
 *
 * `nextPage` is null the moment EVERY lane has run out of pages. That is the
 * whole anti-pollution mechanism: previously this returned `page + 1`
 * unconditionally, so a small catalogue (Israeli TV is 58 titles — 3 pages)
 * paged past its end forever and the deck fell back to whatever generic content
 * was buffered. Now it stops, and the UI shows an honest empty state.
 */
async function hydratePage(
  page: number,
  locale: 'en' | 'he',
  query: DeckQuery,
): Promise<DeckPage> {
  let drafts: MediaDraft[];
  const types: MediaType[] = query.format === 'both' ? ['movie', 'tv'] : [query.format];
  const originCountry = regionCountry(query.region) ?? undefined;
  // Israel additionally constrains the SPOKEN language — origin alone lets
  // English-language Israeli productions dominate the first page. See
  // regionLanguage() for the measured before/after.
  const originalLanguage = regionLanguage(query.region) ?? undefined;
  const minVotes = regionMinVotes(query.region);

  /** Highest `total_pages` seen across every lane on this page. */
  let maxTotalPages = 0;

  /** One category's page, format-mixed, region-constrained. */
  const lane = async (
    options: { genres?: string[] },
    lanePage: number = page,
  ): Promise<MediaDraft[]> => {
    const pages = await Promise.all(
      types.map((type) =>
        fetchDiscoverPage(type, {
          page: lanePage,
          locale,
          minVotes,
          originCountry,
          originalLanguage,
          // A small national catalogue sorted by popularity is noise (TMDB's
          // popularity is a short-window trending score); vote count is the
          // stable proxy for "actually known". Global keeps popularity.
          //
          // It is also what makes the zero vote floor safe for Israel: the
          // best-known titles come back first and the unrated tail sorts to
          // the very end. See REGION_MIN_VOTES.
          sortBy: originCountry ? 'vote_count.desc' : undefined,
          ...options,
        }).catch(() => ({ drafts: [], totalPages: 0 })),
      ),
    );
    for (const result of pages) maxTotalPages = Math.max(maxTotalPages, result.totalPages);
    const lists = pages.map((result) => result.drafts);
    return lists.length === 2 ? interleave(lists[0] ?? [], lists[1] ?? []) : (lists[0] ?? []);
  };

  const chosen = query.genres;

  /** Every lane for one TMDB page, round-robined so each genre is represented. */
  const runLanes = async (lanePage: number): Promise<MediaDraft[]> => {
    const lanes: Array<Promise<MediaDraft[]>> = [];
    if (chosen.length === 0) {
      // Region-only (or format-only) selection: one unfiltered-by-genre lane,
      // still hard-constrained by origin country.
      lanes.push(lane({}, lanePage));
    } else {
      // Rotate which genres lead as pages advance, so a 6-genre pick still gets
      // everything represented instead of only ever the first four.
      const offset =
        chosen.length > MAX_LANES ? ((lanePage - 1) * MAX_LANES) % chosen.length : 0;
      for (let i = 0; i < Math.min(chosen.length, MAX_LANES); i++) {
        const genre = chosen[(offset + i) % chosen.length];
        if (genre) lanes.push(lane({ genres: [genre] }, lanePage));
      }
    }
    return roundRobin(await Promise.all(lanes));
  };

  /** Last TMDB page this call consumed — `nextPage` continues after it. */
  let lastPage = page;

  if (query.strict) {
    drafts = await runLanes(page);

    /*
      Deep-pool top-up for small national catalogues.

      One TMDB page of one genre inside one country can be a handful of titles —
      Israeli Action TV is 30 in total, so page 1 might yield 12, and after the
      user's existing swipes are excluded the deck is empty within a few cards.
      That is the "same three titles forever" report.

      So when a page comes back thin, keep pulling FOLLOWING pages of the SAME
      query until there is a real pool. The constraint is never relaxed to do
      it: same genres, same country, same language. Widening the query instead
      is how a deck that was asked for Israeli drama starts showing Hollywood —
      running out honestly is better than that, and is still what happens once
      `maxTotalPages` is reached.
    */
    if (originCountry) {
      for (let extra = page + 1; extra <= maxTotalPages; extra++) {
        if (drafts.length >= DEEP_POOL_TARGET) break;
        if (extra - page > DEEP_POOL_MAX_EXTRA_PAGES) break;
        drafts = drafts.concat(await runLanes(extra));
        lastPage = extra;
      }

      /*
        Last resort for a small national catalogue: the same country and
        language, with the GENRE constraint dropped.

        This is the one place the deck relaxes a user's genre pick, and it is
        deliberately last. Israeli Action TV is 30 titles in total — page after
        page of it still cannot fill a deck, and the honest end state ("that's
        all") arrives after a dozen cards, which reads as the app being broken
        rather than the catalogue being small. Everything here is still
        Israeli and still Hebrew; only the genre narrowing is released, and
        only once the genre lanes have genuinely been exhausted.
      */
      if (drafts.length < DEEP_POOL_TARGET && chosen.length > 0) {
        for (let extra = page; extra <= maxTotalPages; extra++) {
          if (drafts.length >= DEEP_POOL_TARGET) break;
          if (extra - page > DEEP_POOL_MAX_EXTRA_PAGES) break;
          const wide = await lane({}, extra);
          if (wide.length === 0) break;
          drafts = drafts.concat(wide);
          lastPage = Math.max(lastPage, extra);
        }
      }
    }
  } else {
    // Reached only with no region, no genres and no taste — a true cold start.
    drafts = await fetchTrending(page, locale);
    maxTotalPages = page + 1;
  }

  const unique = new Map<string, MediaDraft>();
  for (const draft of drafts) {
    unique.set(`${draft.media_type}:${draft.tmdb_id}`, draft);
  }

  /**
   * Exhaustion is a property of the CATALOGUE, not of this page's yield: a page
   * can come back empty because every title on it was already swiped while more
   * pages still exist. Only `total_pages` can tell the two apart.
   */
  const nextPage = lastPage >= maxTotalPages ? null : lastPage + 1;
  // A deepened page legitimately carries more than a normal one — capping it
  // back to PAGE_SIZE_TARGET would throw away the titles just fetched to fix
  // the shortage.
  const payload = Array.from(unique.values()).slice(
    0,
    Math.max(PAGE_SIZE_TARGET, DEEP_POOL_TARGET),
  );
  if (payload.length === 0) return { items: [], nextPage };

  /**
   * Cards are built LOCALLY from the TMDB response.
   *
   * This used to round-trip every page through an `upsert_media_items` RPC to
   * mint a database uuid per title. The Run 4 schema removed that whole idea —
   * `swipes`, `watchlist` and `reviews` now key on `(media_id, media_type)`,
   * the TMDB id the client already holds — so the RPC no longer exists and the
   * call 404s, taking the deck down with it the moment a real session exists.
   * The mock-auth branch that used to skip it was hiding exactly this.
   *
   * Nothing is lost: the RPC only ever echoed back the fields TMDB had just
   * returned. Dropping it also removes a network round trip from every page.
   */
  const rows = payload.map(localMediaRow);

  // Exclude titles this user already judged, on the device or elsewhere.
  // Best-effort: signed out, or offline, the local `seenIds`/`library` guards
  // still apply, so a failure here costs a duplicate card, never the deck.
  const seen = new Set<string>();
  if (cloudReady()) {
    const { data: swiped } = await supabase
      .from('swipes')
      .select('media_id, media_type')
      .in('media_id', rows.map((row) => row.tmdb_id));
    for (const row of swiped ?? []) {
      seen.add(`${(row as { media_type: string }).media_type}:${(row as { media_id: number }).media_id}`);
    }
  }

  return {
    items: rows.filter((row) => !seen.has(mediaIdentity(row))),
    nextPage,
  };
}

/** Sum of the user's weights for an item's genres. */
function tasteScore(item: MediaItemRow, weights: Record<string, number>): number {
  let score = 0;
  for (const genre of item.genres) score += weights[genre] ?? 0;
  return score;
}

const EMPTY_EXCLUDE: ReadonlySet<string> = new Set<string>();

/** Stable cross-source identity for a title: same film ⇒ same key. */
export function mediaIdentity(item: { media_type: string; tmdb_id: number }): string {
  return `${item.media_type}:${item.tmdb_id}`;
}

/**
 * Tops `base` back up to VISIBLE_COUNT from the queue, preserving the order
 * and identity of whatever is already on screen.
 *
 * `seen` is checked against CANDIDATES only — never against `base`, which is
 * already on screen and by definition already seen.
 */
function fillVisible(
  base: MediaItemRow[],
  queue: MediaItemRow[],
  exclude: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): MediaItemRow[] {
  if (base.length >= VISIBLE_COUNT) return base;

  const shown = new Set(base.map((card) => card.id));
  const out = [...base];
  for (const candidate of queue) {
    if (out.length >= VISIBLE_COUNT) break;
    if (shown.has(candidate.id) || exclude.has(candidate.id)) continue;
    if (seen.has(mediaIdentity(candidate))) continue;
    out.push(candidate);
    shown.add(candidate.id);
  }

  // Last resort: if the dedupe guard starved the stack (every buffered title
  // has been surfaced before), showing a repeat beats showing an empty deck.
  if (out.length === 0) {
    for (const candidate of queue) {
      if (exclude.has(candidate.id)) continue;
      out.push(candidate);
      break;
    }
  }
  return out;
}

function sameCards(a: MediaItemRow[], b: MediaItemRow[]): boolean {
  return a.length === b.length && a.every((card, i) => card.id === b[i]?.id);
}

export interface UseSwipeDeckResult {
  /**
   * The RENDERED stack — the top card plus the one peeking behind it. Exactly
   * VISIBLE_COUNT entries, deliberately frozen during a gesture.
   *
   * This is not a browsable list of what's coming up. Anything that wants
   * "what could I be shown next" wants `pool`.
   */
  cards: MediaItemRow[];
  /**
   * Everything buffered and un-judged, taste-ranked — typically 20+ titles.
   *
   * Exposed for surfaces that need a POOL rather than a stack (the roulette).
   * Feeding those `cards` instead gives them two items to choose between,
   * which is how the roulette ended up "picking randomly between 2 movies".
   */
  pool: MediaItemRow[];
  topCard: MediaItemRow | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  /** Commits a swipe, updates the taste profile, and advances the deck. */
  swipe: (item: MediaItemRow, direction: SwipeDirection) => void;
  isEmpty: boolean;
  /**
   * The constrained catalogue is genuinely finished — every page fetched, every
   * title judged. Distinct from `isEmpty` (which also covers "still loading
   * nothing") and it is what lets the UI say "you've seen all of Israeli TV"
   * instead of silently serving unrelated content.
   */
  isExhausted: boolean;
  /**
   * Locks the visible stack for the duration of a drag. The card calls this on
   * gesture begin/end so no background refill can re-render it mid-pan.
   */
  setGestureActive: (active: boolean) => void;
  /** What the deck is currently fetching — drives the filter-bar subtitle. */
  query: DeckQuery;
}

export function useSwipeDeck(): UseSwipeDeckResult {
  const locale = useAppStore((s) => s.locale);
  const preferences = useAppStore((s) => s.preferences);
  const deckFilters = useAppStore((s) => s.deckFilters);
  const genreWeights = useAppStore((s) => s.genreWeights);
  const library = useAppStore((s) => s.library);
  const recordSwipe = useAppStore((s) => s.recordSwipe);

  const embedRequested = useRef(false);

  const tasteSwipeCount = useAppStore((s) => s.tasteSwipeCount);
  const seenIds = useAppStore((s) => s.seenIds);
  const markSeen = useAppStore((s) => s.markSeen);
  const region = useAppStore((s) => s.region);

  const topGenres = useMemo(() => selectTopGenres(genreWeights), [genreWeights]);
  const deckQuery = useMemo(
    () => resolveDeckQuery(preferences, deckFilters, topGenres, tasteSwipeCount, region),
    [preferences, deckFilters, topGenres, tasteSwipeCount, region],
  );

  /**
   * Cache identity of the fetched catalogue.
   *
   * ── Genres are sorted, and `source` is NOT in here ─────────────────────
   * Both used to be, and between them they threw the entire deck away while
   * the user was swiping. `resolveDeckQuery` re-sorts the chosen genres by the
   * live taste ranking and flips `source` from 'onboarding' to 'taste' on the
   * 12th swipe — neither changes WHICH catalogue is being fetched, only the
   * order lanes are read in and the label shown in the header. Keying on them
   * meant an ordinary swipe could invalidate the query, blank the visible
   * stack (see the reset below) and refetch from page 1: the deck flashed
   * "you've reached the end", then reloaded. Sorting canonicalises the set so
   * a re-rank is a no-op here, and the taste ordering does the job it is
   * actually for — ranking `queue` — a few lines down.
   */
  const deckKey = [
    locale,
    deckQuery.format,
    [...deckQuery.genres].sort().join(','),
    deckQuery.region,
    deckQuery.strict ? 'strict' : 'open',
  ].join('|');

  /**
   * Axes the USER controls. A change here — and ONLY here — means "show me
   * something else", and is the one thing allowed to blank the cards on screen.
   *
   * Taste drift can still legitimately change `deckKey` (topGenres appearing
   * for a user who picked no genres at all), and when it does the right
   * behaviour is to let the new pages arrive underneath and take over as cards
   * are swiped away — not to empty the screen mid-gesture.
   */
  /**
   * Is the deck the screen the user is actually looking at?
   *
   * Built from `useFocusEffect` rather than `useIsFocused` on purpose:
   * `@react-navigation/native` is present only as a transitive dependency of
   * expo-router and is not in package.json, so importing from it directly
   * would be reaching past our declared dependencies.
   */
  const [deckFocused, setDeckFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setDeckFocused(true);
      return () => setDeckFocused(false);
    }, []),
  );

  /**
   * The format the deck is currently RENDERING, which is not always the format
   * that is currently SELECTED.
   *
   * Format is a shared setting: the Discover screen's Movies/Shows toggle and
   * the deck's own filter bar write the same `deckFilters.format`, so the two
   * screens can never disagree about what the user asked for. But the purge
   * below empties the visible cards, and doing that to a screen the user is not
   * looking at means they return to a deck that threw away their session for no
   * visible reason.
   *
   * So the SELECTED format drives `deckKey` immediately — the new catalogue
   * starts fetching the moment the toggle is tapped — while the RENDERED format
   * only catches up when the deck is on screen. Change it from the deck's own
   * bar and the purge is instant, exactly as before; change it from Discover
   * and the swap is applied on the deck's next appearance, with the pages
   * already warm.
   *
   * This is the same distinction the two keys below have always drawn, applied
   * to one more axis: fetching something new is cheap, blanking the screen is
   * not.
   */
  const renderedFormat = useRef(deckQuery.format);
  if (deckFocused) renderedFormat.current = deckQuery.format;

  const resetKey = [
    locale,
    renderedFormat.current,
    deckQuery.region,
    deckFilters.genre ?? '',
    (preferences?.genres ?? []).join(','),
  ].join('|');

  const query = useInfiniteQuery<DeckPage, Error>({
    // The resolved query is the cache identity: flipping the format toggle,
    // pinning a genre, or a shift in the taste ranking all rebuild the deck.
    queryKey: ['deck', deckKey],
    queryFn: ({ pageParam }) => hydratePage(pageParam as number, locale, deckQuery),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.nextPage,
    staleTime: 10 * 60 * 1000,
  });

  /**
   * Purge the rendered pair the instant the USER changes what they asked for.
   *
   * Keyed on `resetKey`, not on the fetch key: only a deliberate choice
   * (language, format, region, pinned genre, redone onboarding) should ever
   * empty the screen. See the two keys above.
   *
   * Without this, switching Movies → TV Series left the old cards on screen
   * indefinitely: `visible` is independent state, the two movies were neither
   * consumed nor in the library so nothing evicted them, and `fillVisible`
   * returns early once it already holds two cards — so the freshly fetched TV
   * page had nowhere to go. The toggle changed the query and genuinely
   * refetched, and the user still stared at "Troy".
   *
   * This runs as a render-phase reset rather than an effect on purpose: an
   * effect would paint one frame of the WRONG media type before clearing.
   */
  const activeKey = useRef(resetKey);
  const [visible, setVisible] = useState<MediaItemRow[]>([]);
  const [consumed, setConsumed] = useState<Set<string>>(() => new Set());

  if (activeKey.current !== resetKey) {
    activeKey.current = resetKey;
    if (visible.length > 0) setVisible([]);
    if (consumed.size > 0) setConsumed(new Set());
  }

  /**
   * The background queue: everything fetched, minus anything already judged,
   * ranked by taste. This array is free to re-order at any time — it is NOT
   * what gets rendered.
   */
  /**
   * Every TMDB identity the user has already judged, on this device or another.
   *
   * `library` is keyed by ROW id, and rows reach it under two different keys:
   * `localMediaRow` mints `mock-tv-1399` for a swipe made here, while
   * `applyRemoteSnapshot` reconstructs a pulled-down title as `remote-tv-1399`.
   * A lookup by row id therefore misses anything judged on another device, and
   * the title comes round again as if it were new. Comparing on the TMDB
   * identity — which is the same number in both cases — is what actually means
   * "the user has seen this".
   */
  const judged = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of Object.values(library)) ids.add(mediaIdentity(entry.item));
    return ids;
  }, [library]);

  const queue = useMemo(() => {
    const all = (query.data?.pages ?? []).flatMap((p) => p.items);
    const deduped = new Map<string, MediaItemRow>();
    const titles = new Set<string>();

    for (const item of all) {
      // `library` holds every past swipe, so a card the user has already
      // judged never comes back around — by row id AND by TMDB identity.
      if (consumed.has(item.id) || library[item.id] || judged.has(mediaIdentity(item))) {
        continue;
      }

      // A title can legitimately arrive from several lanes at once (anything
      // tagged both War and Drama is returned by both), and across pages after
      // a refetch. Dedupe on the TMDB identity, not just the row id — two rows
      // can carry different ids for the same film.
      const identity = `${item.media_type}:${item.tmdb_id}`;
      if (titles.has(identity)) continue;
      titles.add(identity);

      deduped.set(item.id, item);
    }

    // Ranked by taste; ties keep TMDB's popularity ordering.
    return Array.from(deduped.values())
      .map((item, index) => ({ item, index, score: tasteScore(item, genreWeights) }))
      .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
      .map((entry) => entry.item);
  }, [query.data, consumed, library, judged, genreWeights]);

  /**
   * Hard lock on the visible stack while a finger is down.
   *
   * The refill effect below runs whenever the background queue changes — and
   * the queue changes while the user is mid-gesture, because pages keep
   * arriving and the taste ranking keeps re-sorting. Even though refill
   * preserves cards already on screen, ANY `setVisible` during a drag produces
   * a React re-render of the card under the finger, which is what was still
   * being seen as a flicker.
   *
   * So: while `gestureActive` is true no mutation is applied at all. The
   * pending work is remembered and replayed the moment the gesture settles.
   */
  const gestureActive = useRef(false);
  const refillPending = useRef(false);

  const applyRefill = useCallback(() => {
    setVisible((current) => {
      const alive = current.filter((card) => !consumed.has(card.id) && !library[card.id]);
      const refilled = fillVisible(alive, queue, EMPTY_EXCLUDE, seenIds);
      // Preserve identity when nothing changed so React skips the re-render.
      return sameCards(refilled, current) ? current : refilled;
    });
    // `seenIds` is intentionally read but not depended on — it is written in
    // response to `visible` changing, so depending on it would make the two
    // effects chase each other every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, consumed, library]);

  /**
   * An EMPTY stack is its own refill trigger, independently of the queue.
   *
   * `applyRefill` only changes identity when `queue`, `consumed` or `library`
   * change, and for a long time that was enough: the only thing that emptied
   * the stack was a filter change, which changed `deckKey` and therefore the
   * queue in the same tick.
   *
   * The deferred format swap broke that assumption. There, the queue is
   * replaced while the deck is OFF screen and the purge happens later, on
   * focus — so at the moment the stack is emptied nothing in the dependency
   * list moves (and with no swipes made, `consumed` is already empty, so it is
   * not replaced either). The effect never re-ran and the deck sat on
   * "you've reached the end" with a full queue behind it.
   *
   * Depending on emptiness closes that gap for every future caller too: it is
   * a statement about the invariant — a non-empty queue must never leave an
   * empty stack — rather than about one code path that happens to violate it.
   * It converges in a single extra pass, because once refilled `sameCards`
   * returns the existing array and React skips the render.
   */
  const stackEmpty = visible.length === 0;

  useEffect(() => {
    if (gestureActive.current) {
      refillPending.current = true;
      return;
    }
    applyRefill();
  }, [applyRefill, stackEmpty]);

  /**
   * Called by the card on gesture begin/end.
   *
   * This handle is REFERENTIALLY STABLE for the lifetime of the deck, and that
   * is load-bearing rather than a micro-optimisation. It is a prop on the
   * memoised SwipeCard, and `applyRefill` changes identity every time a page
   * lands or the taste ranking re-sorts — several times a second while
   * scrolling in fresh cards. An unstable handle here means one of two bad
   * outcomes, depending on the memo comparator:
   *
   *   • the comparator ignores it — the card keeps a STALE closure over an old
   *     `queue`/`consumed`, so the refill fired at gesture-end uses data from
   *     before the gesture started; or
   *   • the comparator checks it — the card re-renders mid-drag, which is the
   *     flicker this whole lock exists to prevent.
   *
   * Reading the current implementation out of a ref avoids the choice: the
   * identity never changes and the logic is never stale.
   */
  const latestRefill = useRef(applyRefill);
  latestRefill.current = applyRefill;

  const setGestureActive = useCallback((active: boolean) => {
    gestureActive.current = active;
    if (!active && refillPending.current) {
      refillPending.current = false;
      latestRefill.current();
    }
  }, []);

  // Record what the user has actually been shown, so no title is ever
  // presented twice — including across filter switches and refetches.
  useEffect(() => {
    if (visible.length === 0) return;
    markSeen(visible.map(mediaIdentity));
  }, [visible, markSeen]);

  /**
   * Promotes the next card. Called only once a swipe has committed.
   *
   * Promotion and refill happen in ONE state update. Splitting them (drop the
   * swiped card, let an effect top the stack back up) left a render in which
   * only one card existed, so the behind-card unmounted and immediately
   * remounted with different artwork — a visible flash on every swipe.
   *
   * `queue` still contains the swiped card at this point (`consumed` is
   * updated after), so it is excluded explicitly.
   */
  const advance = useCallback(
    (swipedId: string) => {
      setVisible((current) =>
        fillVisible(
          current.filter((card) => card.id !== swipedId),
          queue,
          new Set([swipedId]),
          seenIds,
        ),
      );
    },
    [queue, seenIds],
  );

  const cards = visible;

  // Keep the buffer topped up so the deck never stalls mid-gesture.
  useEffect(() => {
    if (
      queue.length < MIN_BUFFER &&
      query.hasNextPage &&
      !query.isFetchingNextPage &&
      !query.isLoading
    ) {
      void query.fetchNextPage();
    }
  }, [queue.length, query]);

  /**
   * Warm the posters ahead of the top card so a promotion is never a network
   * wait. Best-effort: prefetch must never throw into the deck.
   *
   * `memory-disk`, not `disk`: a disk-only prefetch still costs a file read
   * plus a decode at the moment the card is promoted, which is exactly the
   * frame that must not do work. Keeping the next few decoded in memory makes
   * promotion a pointer swap. The depth is bounded (w500, ~8 posters) for the
   * same reason DECK_POSTER_SIZE is not `original` — see that constant.
   */
  useEffect(() => {
    const urls = queue
      .slice(0, PREFETCH_DEPTH)
      .map((c) => imageUrl(c.poster_path, DECK_POSTER_SIZE))
      .filter((u): u is string => u !== null);
    if (urls.length === 0) return;

    safeFireAndForget('Image.prefetch', () =>
      Image.prefetch(urls, { cachePolicy: 'memory-disk' }),
    );
    prefetchPalettes(urls);
  }, [queue]);

  // Newly hydrated rows have no embedding yet; ask the backend to backfill.
  useEffect(() => {
    // TODO: MOCK AUTH - REMOVE BEFORE PRODUCTION — no JWT, the call would 401.
    if (MOCK_AUTH_ENABLED) return;

    if (queue.length > 0 && !embedRequested.current) {
      embedRequested.current = true;
      invokeFunction('embed-media', {}).catch(() => {
        // Backfill is best-effort — the deck works without it.
      });
    }
  }, [queue.length]);

  /*
    ── The `apply_swipe` mutation that used to live here has been deleted ────
    It called a function that does not exist, and its failure handler destroyed
    the user's data on every single swipe.

    `supabase.rpc('apply_swipe', …)` answers 404 PGRST202 on the live project —
    verified directly against it, with `community_pulse` as a control returning
    401 (exists, not granted) so the probe distinguishes missing from forbidden.
    The function survives only in the abandoned v1 design, now quarantined at
    `supabase/legacy/0001_init.ABANDONED.sql`. It also took a `uuid`
    media id, while cards are now built locally by `localMediaRow` and carry a
    string id, so it could not have succeeded even where it did exist. This is
    the same Run-4 cleanup that removed `upsert_media_items` — that call site
    was fixed, this one was missed.

    The damage was in `onError`, which ran on every swipe and did two things:

      • `removeFromLibrary(item.id)` — deleting the title the user had just
        swiped, a few hundred ms after it appeared. Liked / To Watch / Seen
        filled in and then emptied out. That is the "lists don't update" report.
      • un-`consumed` the card — putting the swiped title straight back into
        the deck's pool, so it came round again. That is the "same few titles
        forever" report.

    Nothing is lost by removing it: the swipe is already persisted by
    `cloudSyncSwipe` inside `recordSwipe`, which writes `(media_id, media_type)`
    to the `swipes` table in the shape the applied schema actually has, and
    retries from a queue instead of discarding local state on failure.

    ⚠️ Server-side swipe QUOTA went with it, because it lived in that same
    function and has no replacement in the applied schema. The free-tier daily
    limit is currently unenforced; `swipesRemaining` stays null and the counter
    chip hides itself. Re-adding it needs a new RPC keyed on the TMDB id.

    Local state is now authoritative and the server is a mirror of it — which is
    the correct shape for an app that must work on a train anyway. A failed
    write retries; it never deletes what the user did.
  */

  /**
   * Commits a swipe. Everything local happens NOW, in one tick.
   *
   * ── Why this is not deferred any more ──────────────────────────────────
   * A previous revision handed the bookkeeping to `runAfterInteractions` with
   * a `setTimeout` backstop, to keep the taste maths off the frame where the
   * next card appears. It bought a few milliseconds of frame time and cost
   * something far more valuable: for up to 400ms after a swipe the title was
   * in no list. Open "To Watch" quickly enough and the film you had just saved
   * was not there — the tabs looked broken, which they effectively were.
   *
   * The ordering below is the contract: local state first, network after.
   * `recordSwipe` is a single synchronous zustand `set`, so by the time this
   * function returns the Watched / Liked / To Watch selectors already see the
   * title. Nothing waits on Supabase — `cloudSyncSwipe` (inside recordSwipe)
   * enqueues and drains in the background, and `mutation.mutate` starts a
   * promise it does not await.
   *
   * Nothing here is expensive enough to be worth deferring: the real stutter
   * was never this function, it was the 280ms the card spent blocking touches
   * while it animated out. That is fixed where it belongs, in SwipeCard.
   */
  const swipe = useCallback(
    (item: MediaItemRow, direction: SwipeDirection) => {
      // 0. The gesture is over the moment a swipe commits — release the lock
      //    first so the promotion below is applied immediately rather than
      //    being deferred as pending work.
      gestureActive.current = false;
      refillPending.current = false;

      // 1. VISUAL. Drop the swiped card from the rendered pair. The card
      //    behind is already mounted and does not change identity, so this is
      //    a straight promotion with no re-render of the artwork.
      advance(item.id);

      // 2. LOCAL STATE — before anything async is started, and never undone by
      //    anything async afterwards. Records the swipe AND re-weights the
      //    taste profile; re-ranks `queue` (background only), never the
      //    visible pair. `recordSwipe` also enqueues the Supabase write, which
      //    drains in the background and retries on its own.
      recordSwipe(item, direction);
      // Permanent exclusion. Nothing puts this card back in the pool — that is
      // what made the deck loop over the same titles.
      setConsumed((prev) => new Set(prev).add(item.id));

      // 3. NETWORK, fire-and-forget. Not awaited and unable to hold up the next
      //    card: learnTitleCredits does its TMDB round-trip before it touches
      //    state at all, and a failure there costs one title's credits.
      void learnTitleCredits(item, direction);
    },
    [advance, recordSwipe],
  );

  const refetch = useCallback(() => {
    setConsumed(new Set());
    setVisible([]);
    void query.refetch();
  }, [query]);

  const drained =
    !query.isLoading &&
    !query.isFetchingNextPage &&
    !query.hasNextPage &&
    queue.length === 0 &&
    cards.length === 0;

  return {
    cards,
    pool: queue,
    topCard: cards[0] ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch,
    swipe,
    isEmpty: drained,
    // A constrained query that ran dry is a legitimate end state, not a bug —
    // the UI says so rather than widening the query to fill the screen.
    isExhausted: drained && deckQuery.strict,
    setGestureActive,
    query: deckQuery,
  };
}
