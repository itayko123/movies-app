import { useQuery } from '@tanstack/react-query';
import { fetchMediaDetail, type MediaType } from '@/lib/tmdb';
import { useAppStore } from '@/state/store';

/**
 * Resolves a title's runtime on demand.
 *
 * TMDB's `/discover` and `/trending` list endpoints do NOT return runtime — it
 * only exists on the detail endpoint. Rather than fetch details for every
 * buffered card (20+ per page, for a single line of text), this fetches only
 * for the card currently on top.
 *
 * React Query caches per title, so flicking back and forth costs nothing, and a
 * failure is silent: the metadata strip simply omits runtime rather than
 * blocking the card.
 */
export function useCardRuntime(
  tmdbId: number | null,
  mediaType: MediaType | null,
): number | null {
  const locale = useAppStore((s) => s.locale);

  const { data } = useQuery({
    queryKey: ['runtime', tmdbId, mediaType, locale],
    enabled: tmdbId != null && mediaType != null,
    // Runtime is immutable — never refetch it.
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      if (tmdbId == null || mediaType == null) return null;
      const detail = await fetchMediaDetail(tmdbId, mediaType, locale, 'IL');
      return detail.runtime_minutes;
    },
  });

  return data ?? null;
}
