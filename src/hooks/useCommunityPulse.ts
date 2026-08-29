import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { cloudReady } from '@/lib/cloudSync';
import { fetchTitleName, fetchTrendingToday } from '@/lib/tmdb';
import { useAppStore } from '@/state/store';

export interface PulseEntry {
  media_id: number;
  media_type: 'movie' | 'tv';
  /** Real like count. Always 0 for trending entries — see PulseSource. */
  like_count: number;
  title: string;
}

/**
 * Where the line came from. The UI MUST branch on this.
 *
 *  • cloud    — real aggregated likes from other users. Only this source may
 *               be phrased as "N people liked X".
 *  • trending — TMDB's trending/all/day. Never carries a like count, and is
 *               phrased as trending, because dressing catalogue data up as
 *               community activity is simply a lie told to look popular.
 *  • unavailable — nothing to show at all.
 */
export type PulseSource = 'cloud' | 'trending' | 'unavailable';

export interface CommunityPulse {
  entries: PulseEntry[];
  source: PulseSource;
  isLoading: boolean;
}

/**
 * Live community activity for the Discover ticker, with a trending fallback.
 *
 * ── Titles are resolved client-side, on purpose ────────────────────────────
 * `community_pulse()` returns ids and counts only — no titles, no user ids. It
 * cannot leak who watched what (it aggregates behind a k-anonymity floor of
 * three distinct users), and it avoids denormalising a title into the swipes
 * table where it would go stale.
 *
 * ── Why the fallback exists, and what it is NOT allowed to do ──────────────
 * A brand-new install, a signed-out user, or a backend that is simply empty all
 * produced a permanently dead grey banner. The fallback fixes the dead banner
 * by showing what is trending on TMDB today.
 *
 * It does NOT fabricate community activity. Trending entries carry
 * `like_count: 0` and `source: 'trending'`, and the ticker renders them with
 * different copy. The k-anonymity guarantee of the real RPC is worth nothing if
 * the client will happily invent numbers when the RPC returns none.
 */
export function useCommunityPulse(limit = 8): CommunityPulse {
  const locale = useAppStore((s) => s.locale);
  const ready = cloudReady();

  const query = useQuery({
    // `ready` is part of the key: signing in must not serve the signed-out
    // trending result from cache.
    queryKey: ['community-pulse', limit, locale, ready],
    // Community counts are ambient texture, not something worth refetching
    // aggressively — a stale-by-five-minutes number is indistinguishable to
    // the reader and costs far less battery.
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<{ entries: PulseEntry[]; source: PulseSource }> => {
      const trending = async (): Promise<{ entries: PulseEntry[]; source: PulseSource }> => {
        try {
          const drafts = await fetchTrendingToday(locale);
          const entries = drafts.slice(0, limit).map((draft) => ({
            media_id: draft.tmdb_id,
            media_type: draft.media_type,
            like_count: 0,
            title: draft.title,
          }));
          return {
            entries,
            source: entries.length > 0 ? 'trending' : 'unavailable',
          };
        } catch (error) {
          // TMDB down as well — the banner hides rather than showing an error.
          if (__DEV__) console.warn('[pulse] trending fallback failed:', error);
          return { entries: [], source: 'unavailable' };
        }
      };

      if (!ready) return trending();

      try {
        const { data, error } = await supabase.rpc('community_pulse', {
          p_hours: 24,
          p_limit: limit,
        });
        // The RPC failing used to surface as an empty ticker indistinguishable
        // from a quiet community — a missing migration looked like normal
        // operation. Say so in dev, then fall back rather than going dark.
        if (error) throw error;

        const rows = (data ?? []) as Array<{
          media_id: number;
          media_type: 'movie' | 'tv';
          like_count: number;
        }>;
        if (rows.length === 0) return trending();

        const resolved = await Promise.all(
          rows.map(async (row) => {
            // fetchTitleName already swallows its own failures — one
            // unresolvable title drops out rather than emptying the ticker.
            const title = await fetchTitleName(row.media_id, row.media_type, locale);
            return title ? { ...row, title } : null;
          }),
        );

        const entries = resolved.filter((entry): entry is PulseEntry => entry != null);
        // Every id failed to resolve: real activity, unusable output.
        return entries.length > 0 ? { entries, source: 'cloud' } : trending();
      } catch (error) {
        if (__DEV__) {
          console.warn(
            '[pulse] community_pulse RPC failed — falling back to trending. ' +
              'If this persists, check that the function exists and is granted to authenticated:',
            error,
          );
        }
        return trending();
      }
    },
  });

  return {
    entries: query.data?.entries ?? [],
    source: query.data?.source ?? 'unavailable',
    isLoading: query.isLoading,
  };
}
