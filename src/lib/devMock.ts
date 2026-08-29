// ═══════════════════════════════════════════════════════════════════════════
// TODO: MOCK AUTH - REMOVE BEFORE PRODUCTION
// ═══════════════════════════════════════════════════════════════════════════
//
// Temporary development scaffold that lets the app be opened straight into the
// (tabs) group without a real Supabase session, so UI work isn't blocked on the
// auth flow.
//
// HOW TO TURN IT OFF
//   • Permanently: delete this file and the two `MOCK AUTH` blocks that import
//     it — `app/_layout.tsx` and `src/hooks/useSwipeDeck.ts`.
//   • For one run (to test the real login flow): set EXPO_PUBLIC_MOCK_AUTH=false
//     in .env and restart with `npx expo start --clear`.
//
// SAFETY: hard-gated behind `__DEV__`, so this is inert in any release build
// (`expo export`, EAS production/preview) even if the file is left in place.
//
// WHAT IT DOES NOT DO: it does not authenticate you against Supabase. Anything
// that needs a real JWT still fails — mood search (Edge Function), Duo-Match,
// watchlist, premium stats, and persisting swipes. Only the swipe deck is
// stubbed end-to-end (see useSwipeDeck) because that's the main UI surface.
// ═══════════════════════════════════════════════════════════════════════════

import type { Session } from '@supabase/supabase-js';
import type { Profile } from '@/types/db';
import type { MediaDraft } from '@/lib/tmdb';
import type { MediaItemRow } from '@/types/media';

export const MOCK_AUTH_ENABLED =
  __DEV__ && process.env.EXPO_PUBLIC_MOCK_AUTH !== 'false';

/** Flip to `true` to preview premium-only surfaces (Duo tab, deep stats, no ads). */
const MOCK_IS_PREMIUM = false;

const MOCK_USER_ID = '00000000-0000-4000-8000-000000000001';

/** Shaped like a real Session so the auth gate and `session?.user.id` reads work. */
const MOCK_SESSION = {
  access_token: 'mock-access-token',
  refresh_token: 'mock-refresh-token',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: 'bearer',
  user: {
    id: MOCK_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'ui-tester@cineswipe.local',
    app_metadata: {},
    user_metadata: {},
    created_at: new Date(0).toISOString(),
  },
} as unknown as Session;

const MOCK_PROFILE: Profile = {
  id: MOCK_USER_ID,
  display_name: 'ui_tester',
  avatar_url: null,
  locale: 'en',
  is_premium: MOCK_IS_PREMIUM,
  streak_count: 0,
  longest_streak: 0,
  last_swipe_date: null,
  cinephile_level: 1,
  xp: 0,
};

export function mockAuthState(): { session: Session; profile: Profile } {
  return { session: MOCK_SESSION, profile: MOCK_PROFILE };
}

/**
 * Stand-in for the `apply_swipe` RPC result. Keeps `is_premium` consistent
 * with MOCK_IS_PREMIUM so a swipe doesn't silently flip the entitlement state
 * and hide the ad/paywall surfaces mid-session.
 */
export function mockSwipeResult(): {
  allowed: true;
  swipes_remaining: null;
  is_premium: boolean;
} {
  return { allowed: true, swipes_remaining: null, is_premium: MOCK_IS_PREMIUM };
}

/**
 * Turns a TMDB draft into a deck row without the `upsert_media_items` RPC
 * (which requires a real JWT). The id is synthetic and deterministic — it is
 * NOT a database uuid, so detail-screen queries keyed on it return nothing.
 */
export function mockMediaRow(draft: MediaDraft): MediaItemRow {
  return {
    id: `mock-${draft.media_type}-${draft.tmdb_id}`,
    tmdb_id: draft.tmdb_id,
    media_type: draft.media_type,
    title: draft.title,
    original_title: draft.original_title,
    overview: draft.overview,
    poster_path: draft.poster_path,
    backdrop_path: draft.backdrop_path,
    genres: draft.genres,
    runtime_minutes: draft.runtime_minutes,
    release_year: draft.release_year,
    vote_average: draft.vote_average,
    popularity: draft.popularity,
    origin_country: draft.origin_country,
  };
}
