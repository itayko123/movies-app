import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { EngagementPointSchema, type EngagementPoint } from '@/types/media';

export interface EngagementData {
  points: EngagementPoint[];
  /** Highest-scoring spike — the "it takes off here" moment. */
  peak: EngagementPoint | null;
}

/**
 * "When It Gets Good": community + AI engagement spikes for a series,
 * ordered chronologically (season → episode → minute).
 */
export function useEngagement(mediaItemId: string | null) {
  return useQuery<EngagementData, Error>({
    queryKey: ['engagement', mediaItemId],
    enabled: mediaItemId != null,
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('engagement_points')
        .select('id, media_item_id, season, episode, minute, score, source')
        .eq('media_item_id', mediaItemId as string)
        .order('season', { ascending: true })
        .order('episode', { ascending: true })
        .order('minute', { ascending: true });
      if (error) throw new Error(error.message);

      const points = EngagementPointSchema.array().parse(data ?? []);
      const peak = points.reduce<EngagementPoint | null>(
        (best, point) => (best == null || point.score > best.score ? point : best),
        null,
      );
      return { points, peak };
    },
  });
}
