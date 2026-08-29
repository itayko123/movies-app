import { useQuery } from '@tanstack/react-query';
import {
  fetchMediaDetail,
  fetchMediaImages,
  type MediaDetail,
  type MediaImages,
  type MediaType,
} from '@/lib/tmdb';
import { useAppStore } from '@/state/store';
import { regionCountry, TMDB_REGION } from '@/lib/tmdb';

/**
 * Full TMDB detail payload (runtime, cast, streaming providers).
 * Providers are resolved for the user's country — real-time availability
 * via TMDB's licensed JustWatch data.
 */
export function useMediaDetail(tmdbId: number, mediaType: MediaType) {
  const locale = useAppStore((s) => s.locale);
  /**
   * Watch-provider availability is per country. This used to read
   * `profile.country_code`, a column the Run 4 schema dropped; the region the
   * user actually picked in the app is a better source anyway — it is what
   * they chose, it works signed-out, and GLOBAL falls back to the app's home
   * market rather than to the US.
   */
  const region = useAppStore((s) => s.region);
  const countryCode = regionCountry(region) ?? TMDB_REGION;

  return useQuery<MediaDetail, Error>({
    queryKey: ['media-detail', tmdbId, mediaType, locale, countryCode],
    queryFn: () => fetchMediaDetail(tmdbId, mediaType, locale, countryCode),
    enabled: Number.isFinite(tmdbId) && tmdbId > 0,
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * Full international poster/backdrop set for the detail gallery.
 * Language-independent (the strip deliberately mixes locales), so the
 * cache key skips locale — one fetch serves both app languages.
 */
export function useMediaImages(tmdbId: number, mediaType: MediaType) {
  return useQuery<MediaImages, Error>({
    queryKey: ['media-images', tmdbId, mediaType],
    queryFn: () => fetchMediaImages(tmdbId, mediaType),
    enabled: Number.isFinite(tmdbId) && tmdbId > 0,
    staleTime: 24 * 60 * 60 * 1000,
  });
}
