import { useQuery } from '@tanstack/react-query';
import { fetchTrending } from '@/lib/tmdb';
import { useAppStore } from '@/state/store';

/**
 * Poster art for the login wall.
 *
 * Deliberately NOT blocking: the wall renders and animates on designed
 * gradient tiles regardless, and these paths fade in on top whenever they
 * arrive (see PosterWall). So this query has no loading state anyone waits on,
 * a long staleTime, and it fails silently — a login screen must never surface
 * a TMDB error.
 *
 * `gcTime` is a full day so returning to the login screen within a session
 * re-uses the same list, and expo-image serves the files from disk.
 */
export function useWallPosters() {
  const locale = useAppStore((s) => s.locale);

  const query = useQuery({
    queryKey: ['wall-posters'],
    queryFn: async () => {
      // Two pages of trending gives ~40 titles — enough that the three columns
      // never visibly repeat a poster within one screen height.
      const [a, b] = await Promise.all([
        fetchTrending(1, locale).catch(() => []),
        fetchTrending(2, locale).catch(() => []),
      ]);
      return [...a, ...b]
        .map((item) => item.poster_path)
        .filter((path): path is string => Boolean(path));
    },
    staleTime: 12 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });

  return query.data ?? [];
}
