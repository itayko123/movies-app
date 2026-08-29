import { z } from 'zod';
import { MediaTypeSchema } from '@/types/media';

/**
 * Mirrors `public.profiles` in supabase_schema.sql.
 *
 * Rewritten to match the deployed table: the previous shape still described the
 * pre-Run-4 schema (`username`, `country_code`, `swipes_today`, `swipe_date`),
 * none of which exist any more. PostgREST rejects a select naming unknown
 * columns outright, so the FIRST profile fetch after a real sign-in returned an
 * error and the profile silently stayed null — taking `is_premium` with it.
 */
export const ProfileSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  locale: z.enum(['en', 'he']),
  is_premium: z.boolean(),
  streak_count: z.number(),
  longest_streak: z.number(),
  last_swipe_date: z.string().nullable(),
  cinephile_level: z.number(),
  xp: z.number(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** Result of the apply_swipe RPC — the server is the quota authority. */
export const SwipeResultSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  swipes_remaining: z.number().nullable().optional(),
  is_premium: z.boolean(),
});
export type SwipeResult = z.infer<typeof SwipeResultSchema>;

/*
  REMOVED in Phase 6 Step 1: DuoSessionSchema / DuoPickSchema.

  They described the abandoned v1 `duo_sessions` table and the `duo_match`
  RPC, neither of which exists in the live database. Their only consumer was
  `useDuoSession`, deleted alongside them. Left in place they were a landmine:
  a plausible-looking typed schema pointing at nothing.

  The live duo model is `duo_rooms` + `duo_matches`, joined by a six-character
  room code — see the baseline migration and `src/lib/duoCloud.ts`.
*/

export const UserStatsSchema = z.object({
  total_swipes: z.number(),
  likes: z.number(),
  superlikes: z.number(),
  dislikes: z.number(),
  top_genres: z.array(z.object({ genre: z.string(), count: z.number() })),
});
export type UserStats = z.infer<typeof UserStatsSchema>;
