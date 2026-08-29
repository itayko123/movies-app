import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.47.10';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

/**
 * Atomic fixed-window rate limit backed by the `rate_limits` table.
 * Must be called with the service-role client (RLS denies everyone else).
 */
export async function checkRateLimit(
  admin: SupabaseClient,
  userId: string,
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const { data, error } = await admin.rpc('check_rate_limit', {
    p_user_id: userId,
    p_bucket: bucket,
    p_max: max,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    throw new Error(`rate limit check failed: ${error.message}`);
  }
  return data as RateLimitResult;
}
