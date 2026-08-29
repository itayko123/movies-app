import { z } from 'zod';

export const MediaTypeSchema = z.enum(['movie', 'tv']);
export type MediaType = z.infer<typeof MediaTypeSchema>;

/**
 * Four-way gesture vocabulary:
 *   like      → swipe right (LTR) / left (RTL), or the green button
 *   dislike   → the opposite horizontal direction, or the red button
 *   superlike → swipe up, or the star button — saves to the Watchlist
 *   seen      → swipe down, or the eye button — "already watched it"
 */
export const SwipeDirectionSchema = z.enum(['like', 'dislike', 'superlike', 'seen']);
export type SwipeDirection = z.infer<typeof SwipeDirectionSchema>;

/** A media_items row as returned by Supabase (embedding never selected). */
export const MediaItemRowSchema = z.object({
  id: z.string().uuid(),
  tmdb_id: z.number(),
  media_type: MediaTypeSchema,
  title: z.string(),
  original_title: z.string().nullable(),
  overview: z.string().nullable(),
  poster_path: z.string().nullable(),
  backdrop_path: z.string().nullable(),
  genres: z.array(z.string()),
  runtime_minutes: z.number().nullable(),
  release_year: z.number().nullable(),
  vote_average: z.coerce.number().nullable(),
  popularity: z.coerce.number().nullable(),
  origin_country: z.array(z.string()),
});
export type MediaItemRow = z.infer<typeof MediaItemRowSchema>;

/** One row from the match_media RPC. */
export const MoodResultSchema = z.object({
  id: z.string().uuid(),
  tmdb_id: z.number(),
  media_type: MediaTypeSchema,
  title: z.string(),
  overview: z.string().nullable(),
  poster_path: z.string().nullable(),
  backdrop_path: z.string().nullable(),
  genres: z.array(z.string()),
  runtime_minutes: z.number().nullable(),
  release_year: z.number().nullable(),
  vote_average: z.coerce.number().nullable(),
  similarity: z.number(),
});
export type MoodResult = z.infer<typeof MoodResultSchema>;

export const MoodSearchResponseSchema = z.object({
  reply: z.string(),
  intent: z.object({
    search_text: z.string(),
    genres: z.array(z.string()),
    media_type: z.enum(['movie', 'tv', 'any']),
    max_runtime_minutes: z.number().nullable(),
    min_year: z.number().nullable(),
  }),
  results: z.array(MoodResultSchema),
});
export type MoodSearchResponse = z.infer<typeof MoodSearchResponseSchema>;

export const EngagementPointSchema = z.object({
  id: z.number(),
  media_item_id: z.string().uuid(),
  season: z.number(),
  episode: z.number(),
  minute: z.number(),
  score: z.coerce.number(),
  source: z.enum(['ai', 'community']),
});
export type EngagementPoint = z.infer<typeof EngagementPointSchema>;
