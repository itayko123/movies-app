import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchDiscover,
  fetchRegionalContent,
  fetchRegionalPicks,
  regionCountry,
  regionMeta,
  type MediaDraft,
} from '@/lib/tmdb';
import {
  useAppStore,
  selectTopGenres,
  selectGenreStats,
  selectTopPeople,
  type PersonAffinity,
} from '@/state/store';
import { genreLabel, genreList } from '@/i18n/genres';

export type ShelfKey =
  | 'forYou.topPicks'
  | 'forYou.local'
  | 'forYou.binge'
  | 'forYou.hiddenGems'
  | 'forYou.becauseYouLike'
  | 'forYou.withActor'
  | 'forYou.fromDirector';

/**
 * Why a shelf exists, as a translation key plus its interpolation values.
 *
 * Carried as a key + params rather than a finished string so the reason stays
 * translatable — building "Because you liked 5 Sci-Fi titles" in the hook would
 * hard-code English into the data layer.
 */
export interface ShelfReason {
  key:
    | 'forYou.whyTaste'
    | 'forYou.whyGenre'
    | 'forYou.whyOnboarding'
    | 'forYou.whyRegion'
    | 'forYou.whyBinge'
    | 'forYou.whyGems'
    | 'forYou.whyActor'
    | 'forYou.whyDirector';
  params?: Record<string, string | number>;
}

/** One horizontal shelf of the For You screen. */
export interface RecommendationRow {
  id: string;
  /** Set only for the "because you like X" row, which interpolates the name. */
  genre: string | null;
  titleKey: ShelfKey;
  /** Interpolation values for `titleKey` (a genre or a person's name). */
  titleParams?: Record<string, string | number>;
  /** Plain-language justification shown above the shelf. */
  reason: ShelfReason;
  items: MediaDraft[];
}

/**
 * A shelf before its reason is attached.
 *
 * Reasons are computed OUTSIDE the query, from `library`, so they stay live as
 * the user swipes. Baking them into the cached query result would freeze the
 * numbers at whatever they were when the shelves were last fetched (15-minute
 * staleTime) — the tag would confidently claim "you liked 3 Thrillers" long
 * after it became 11.
 */
type ShelfSeed = Omit<RecommendationRow, 'reason'>;

/** A shelf needs this many titles to be worth a row of its own. */
const MIN_SHELF = 3;

function dedupeAcross(rows: ShelfSeed[]): ShelfSeed[] {
  // A title should appear on one shelf only, otherwise the grid feels padded.
  const seen = new Set<string>();
  return rows
    .map((row) => ({
      ...row,
      items: row.items.filter((item) => {
        const key = `${item.media_type}:${item.tmdb_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    }))
    .filter((row) => row.items.length >= MIN_SHELF);
}

const safe = (p: Promise<MediaDraft[]>) => p.catch(() => [] as MediaDraft[]);

/**
 * Builds the For You shelves from the learned taste vector.
 *
 * ── What changed, and why it matters ───────────────────────────────────────
 * The shelves used to be built from genre weights alone, and two of them
 * ("binge", "hidden gems") carried no personal signal at all — they were the
 * global top-rated list, identical for every user on the planet. That is what
 * made the screen feel generic despite being labelled "For You".
 *
 * Now every shelf is constrained by something the user actually did:
 *   • genre shelves  → learned genreWeights
 *   • person shelves → learned personWeights (director / top-billed cast)
 *   • binge + gems   → still quality-first, but filtered to the taste genres
 *
 * Person shelves are MOVIE-ONLY by construction. TMDB's `/discover/tv` accepts
 * `with_cast` and silently ignores it (verified: it returns the same 228,656
 * unfiltered results), so a TV person shelf would be a lie dressed as
 * personalisation. See `supportsPeopleFilter`.
 */
export function useRecommendations() {
  const locale = useAppStore((s) => s.locale);
  const genreWeights = useAppStore((s) => s.genreWeights);
  const personWeights = useAppStore((s) => s.personWeights);
  const preferences = useAppStore((s) => s.preferences);
  const library = useAppStore((s) => s.library);

  const topGenres = useMemo(() => selectTopGenres(genreWeights, 4), [genreWeights]);
  const effectiveGenres = topGenres.length > 0 ? topGenres : (preferences?.genres ?? []);

  /**
   * Format is read from the SHARED `deckFilters`, not from a screen-local
   * state.
   *
   * Discover's Movies/Shows toggle and the deck's own filter bar are two views
   * of one setting: a user who narrows to Shows here expects Shows when they
   * reach the deck. Keeping a private copy on this screen was the obvious
   * implementation and the wrong one — it produces two "current formats" that
   * silently disagree.
   *
   * The reason a shared value is safe here (it purges the deck's rendered
   * cards) is handled at the other end: see the focus gate in useSwipeDeck,
   * which defers that purge until the deck is actually on screen.
   */
  const deckFormat = useAppStore((s) => s.deckFilters.format);
  const format = deckFormat ?? preferences?.mediaType ?? 'both';
  const region = useAppStore((s) => s.region);
  // Global has no country of its own, so the local shelf falls back to IL —
  // this is an Israeli-audience app and a "local" shelf should still mean
  // something when no region is pinned.
  const localRegion = regionCountry(region) ? region : 'IL';
  const regionPinned = regionCountry(region) !== null;
  const leadGenre = effectiveGenres[0] ?? null;

  /** The strongest learned actor and director, if either cleared the bar. */
  const leadActor = useMemo(
    () => selectTopPeople(personWeights, 'cast', 1)[0] ?? null,
    [personWeights],
  );
  const leadDirector = useMemo(
    () => selectTopPeople(personWeights, 'director', 1)[0] ?? null,
    [personWeights],
  );

  const query = useQuery<ShelfSeed[], Error>({
    queryKey: [
      'recommendations',
      locale,
      format,
      effectiveGenres.join(','),
      region,
      // Person ids, so the shelves rebuild when a new favourite emerges —
      // but NOT on every weight nudge, which would refetch constantly.
      leadActor?.id ?? 0,
      leadDirector?.id ?? 0,
    ],
    staleTime: 15 * 60 * 1000,
    queryFn: async () => {
      const types = format === 'both' ? (['movie', 'tv'] as const) : ([format] as const);

      /**
       * Person shelves cannot exist under a Shows-only filter.
       *
       * They are movie-only by construction — `/discover/tv` silently ignores
       * `with_cast`/`with_crew`, so there is no TV equivalent to fall back to
       * (see supportsPeopleFilter). That was invisible while format lived on
       * another screen; with a Movies/Shows toggle sitting directly above the
       * shelves, a row of DiCaprio FILMS under an active "Shows" pill reads as
       * the filter being broken.
       *
       * Dropping the row costs the user their two most personal shelves in
       * this one mode, which is a real loss — but a filter that visibly does
       * not apply costs trust in every other shelf on the screen.
       */
      const peopleShelvesApply = format !== 'tv';
      const across = (run: (t: 'movie' | 'tv') => Promise<MediaDraft[]>) =>
        Promise.all(types.map(run)).then((pages) => pages.flat());

      const [topPicks, local, binge, hiddenGems, leadGenreItems, actorItems, directorItems] =
        await Promise.all([
          // 1. Top picks — the whole taste profile, sorted by rating rather than
          //    raw popularity so the hero shelf is genuinely "best", not loudest.
          across((type) =>
            safe(
              fetchDiscover(type, {
                page: 1,
                locale,
                genres: effectiveGenres,
                sortBy: 'vote_average.desc',
                minVotes: 500,
              }),
            ),
          ),

          // 2. Popular content from the active region — vote-count sorted, and
          //    honouring the format filter for the same reason as the binge
          //    shelf below. `fetchRegionalPicks` interleaves film and
          //    television by design, which is right for 'both' and wrong the
          //    moment the user has narrowed: it was surfacing Tehran under an
          //    active "Movies" pill. Narrowed, we go straight to the
          //    single-type fetcher the picks helper is itself built on.
          format === 'both'
            ? safe(fetchRegionalPicks(1, locale, localRegion))
            : safe(fetchRegionalContent(format, { page: 1, locale, region: localRegion })),

          // 3. Top rated binge series. TV by definition — "binge" is
          //    meaningless for a film — and therefore SKIPPED ENTIRELY when the
          //    user has narrowed to Movies.
          //
          //    This shelf used to ignore the format preference, on the
          //    reasoning that it is a TV-only concept. That was defensible
          //    while format lived in a filter bar on another screen; it is not
          //    now that Discover puts a Movies/Shows toggle directly above the
          //    shelves. A row of series under an active "Movies" pill reads as
          //    the filter being broken, and a filter that visibly does not
          //    apply is worse than a missing shelf.
          //
          //    `genres` is omitted rather than passed empty, because an empty
          //    array trips the strict-genre guard and returns nothing at all
          //    for a user with no taste signal yet.
          format === 'movie'
            ? Promise.resolve<MediaDraft[]>([])
            : safe(
                fetchDiscover('tv', {
                  page: 1,
                  locale,
                  ...(effectiveGenres.length > 0 ? { genres: effectiveGenres } : {}),
                  sortBy: 'vote_average.desc',
                  minVotes: 800,
                }),
              ),

          // 4. Hidden gems — excellent but under-watched. The upper vote bound is
          //    what makes it a *discovery* shelf: without it this is just the
          //    top-rated list again with the same blockbusters.
          across((type) =>
            safe(
              fetchDiscover(type, {
                page: 1,
                locale,
                ...(effectiveGenres.length > 0 ? { genres: effectiveGenres } : {}),
                minRating: 8,
                minVotes: 120,
                maxVotes: 2500,
                sortBy: 'vote_average.desc',
              }),
            ),
          ),

          // 5. Because you like X — one deep cut on the strongest single genre.
          leadGenre
            ? across((type) =>
                safe(
                  fetchDiscover(type, {
                    page: 1,
                    locale,
                    genres: [leadGenre],
                    minVotes: 200,
                  }),
                ),
              )
            : Promise.resolve<MediaDraft[]>([]),

          // 6 & 7. The person shelves. Movie-only — see the note above.
          leadActor && peopleShelvesApply
            ? safe(
                fetchDiscover('movie', {
                  page: 1,
                  locale,
                  castIds: [leadActor.id],
                  sortBy: 'vote_count.desc',
                  minVotes: 50,
                }),
              )
            : Promise.resolve<MediaDraft[]>([]),

          leadDirector && peopleShelvesApply
            ? safe(
                fetchDiscover('movie', {
                  page: 1,
                  locale,
                  crewIds: [leadDirector.id],
                  sortBy: 'vote_count.desc',
                  minVotes: 50,
                }),
              )
            : Promise.resolve<MediaDraft[]>([]),
        ]);

      const localRow: ShelfSeed = {
        id: 'local',
        genre: null,
        titleKey: 'forYou.local',
        items: local,
      };

      /**
       * Person shelves sit high in the order.
       *
       * They are the most specific claim the app can make — "you liked three
       * films with this actor" is far more concrete than "you like Drama" —
       * so burying them under the generic shelves would waste the signal.
       */
      const personRows: ShelfSeed[] = !peopleShelvesApply ? [] : [
        ...(leadActor
          ? [
              {
                id: `actor-${leadActor.id}`,
                genre: null,
                titleKey: 'forYou.withActor' as const,
                titleParams: { name: leadActor.name },
                items: actorItems,
              },
            ]
          : []),
        ...(leadDirector
          ? [
              {
                id: `director-${leadDirector.id}`,
                genre: null,
                titleKey: 'forYou.fromDirector' as const,
                titleParams: { name: leadDirector.name },
                items: directorItems,
              },
            ]
          : []),
      ];

      const rest: ShelfSeed[] = [
        ...(leadGenre
          ? [
              {
                id: `genre-${leadGenre}`,
                genre: leadGenre,
                titleKey: 'forYou.becauseYouLike' as const,
                titleParams: { genre: genreLabel(leadGenre, locale) },
                items: leadGenreItems,
              },
            ]
          : []),
        { id: 'binge', genre: null, titleKey: 'forYou.binge', items: binge },
        { id: 'gems', genre: null, titleKey: 'forYou.hiddenGems', items: hiddenGems },
      ];

      const rows: ShelfSeed[] = [
        { id: 'top', genre: null, titleKey: 'forYou.topPicks', items: topPicks },
        // Someone who has pinned a region shouldn't have to scroll past three
        // other shelves to reach that region's content.
        ...(regionPinned
          ? [localRow, ...personRows, ...rest]
          : [...personRows, ...rest, localRow]),
      ];

      return dedupeAcross(rows);
    },
  });

  const genreStats = useMemo(() => selectGenreStats(library), [library]);
  const regionLabel = regionMeta(localRegion).label;

  /**
   * Distinct titles liked/saved that carry ANY of the given genres.
   *
   * Summing per-genre counts is wrong twice over: a title tagged both Drama and
   * War is counted twice, and summing genres the label doesn't name inflates
   * the claim further. The first version of this said "you liked 24 Drama & War
   * titles" against a 16-title library — the number has to describe exactly the
   * genres shown next to it.
   */
  const countTitlesIn = useMemo(
    () => (genres: string[]) => {
      if (genres.length === 0) return 0;
      const wanted = new Set(genres);
      let count = 0;
      for (const entry of Object.values(library)) {
        if (entry.direction !== 'like' && entry.direction !== 'superlike') continue;
        if (entry.item.genres.some((genre) => wanted.has(genre))) count += 1;
      }
      return count;
    },
    [library],
  );

  /**
   * Turns a shelf into a claim the user can verify against their own memory.
   *
   * Every number here comes from actual recorded swipes. Where there is no
   * swipe history yet (a brand-new account whose genres came from onboarding)
   * the reason says so honestly rather than inventing a count.
   */
  const reasonFor = useMemo(
    () =>
      (row: ShelfSeed): ShelfReason => {
        const stat = row.genre ? genreStats[row.genre] : undefined;
        const person = (p: PersonAffinity | null) => p?.name ?? '';

        switch (row.titleKey) {
          case 'forYou.becauseYouLike':
            return stat && stat.positive > 0
              ? {
                  key: 'forYou.whyGenre',
                  params: { count: stat.positive, genre: genreLabel(row.genre ?? '', locale) },
                }
              : {
                  key: 'forYou.whyOnboarding',
                  params: { genre: genreLabel(row.genre ?? '', locale) },
                };

          // `count` is the number of distinct swiped titles the credit appeared
          // on, tracked at learn time — not a re-derived estimate.
          case 'forYou.withActor':
            return {
              key: 'forYou.whyActor',
              params: { count: leadActor?.count ?? 0, name: person(leadActor) },
            };

          case 'forYou.fromDirector':
            return {
              key: 'forYou.whyDirector',
              params: { count: leadDirector?.count ?? 0, name: person(leadDirector) },
            };

          case 'forYou.local':
            return { key: 'forYou.whyRegion', params: { region: regionLabel } };

          case 'forYou.binge':
            return { key: 'forYou.whyBinge' };

          case 'forYou.hiddenGems':
            return { key: 'forYou.whyGems' };

          default: {
            // Top picks. Pick the genres to NAME first, then count only those,
            // so the number and the names always describe the same set.
            const named = effectiveGenres
              .map((genre) => genreStats[genre])
              .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
              .filter((entry) => entry.positive > 0)
              .sort((a, b) => b.positive - a.positive)
              .slice(0, 2)
              .map((entry) => entry.genre);

            const total = countTitlesIn(named);
            return total > 0
              ? {
                  key: 'forYou.whyTaste',
                  params: { count: total, genres: genreList(named, locale) },
                }
              : {
                  key: 'forYou.whyOnboarding',
                  params: { genre: genreList(effectiveGenres.slice(0, 2), locale) },
                };
          }
        }
      },
    [genreStats, effectiveGenres, regionLabel, countTitlesIn, leadActor, leadDirector, locale],
  );

  // Hide anything already swiped so the shelves stay actionable.
  const rows = useMemo<RecommendationRow[]>(() => {
    const judged = new Set(
      Object.values(library).map((entry) => `${entry.item.media_type}:${entry.item.tmdb_id}`),
    );
    return (query.data ?? [])
      .map((row) => ({
        ...row,
        items: row.items.filter((item) => !judged.has(`${item.media_type}:${item.tmdb_id}`)),
      }))
      .filter((row) => row.items.length >= MIN_SHELF)
      .map((row) => ({ ...row, reason: reasonFor(row) }));
  }, [query.data, library, reasonFor]);

  return {
    rows,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    hasTaste: effectiveGenres.length > 0,
    topGenres: effectiveGenres,
    /** Label for the local shelf, e.g. "Korea". */
    localRegionLabel: regionLabel,
    /** Strongest learned credits — surfaced in the header subtitle. */
    leadActor,
    leadDirector,
  };
}
