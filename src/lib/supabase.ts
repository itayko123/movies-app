import 'react-native-url-polyfill/auto';
import { AppState, Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import { env, isSupabaseConfigured } from '@/lib/env';
import { supabaseAuthStorage } from '@/lib/storage';

export { isSupabaseConfigured };

/**
 * Placeholder used when no backend is configured.
 *
 * `createClient` throws on an empty URL, and this module is imported at the top
 * of the dependency graph, so an unconfigured project would fail to boot at
 * all. Handing it a syntactically valid but unroutable address keeps every
 * import site working; requests against it fail as ordinary network errors,
 * which the cloud layer already treats as "offline" and falls back from.
 *
 * Nothing should reach that point regardless: callers gate on
 * `isSupabaseConfigured` (or `cloudReady()`) first. This is the backstop, not
 * the mechanism.
 */
const PLACEHOLDER_URL = 'https://unconfigured.invalid';
const PLACEHOLDER_KEY = 'unconfigured-anon-key';

export const supabase = createClient(
  isSupabaseConfigured ? env.EXPO_PUBLIC_SUPABASE_URL : PLACEHOLDER_URL,
  isSupabaseConfigured ? env.EXPO_PUBLIC_SUPABASE_ANON_KEY : PLACEHOLDER_KEY,
  {
    auth: {
      storage: supabaseAuthStorage,
      autoRefreshToken: isSupabaseConfigured,
      persistSession: isSupabaseConfigured,
      // Web signs in via OAuth redirect (see src/lib/auth.web.ts) — the
      // session comes back in the URL and must be detected there.
      detectSessionInUrl: Platform.OS === 'web' && isSupabaseConfigured,
      /**
       * PKCE, not the implicit flow.
       *
       * Required by the native Google fallback: outside a dev client there is
       * no native Google module, so sign-in goes out to the system browser and
       * comes back on the `cineswipe://` deep link carrying a `code`, which
       * only `exchangeCodeForSession` can redeem — and that needs the verifier
       * PKCE stores. Implicit would return the token in the URL fragment,
       * which a deep link does not reliably preserve.
       *
       * On web it changes nothing the user sees: `detectSessionInUrl` redeems
       * the `?code=` automatically. Email OTP is unaffected either way, since
       * a six-digit token is verified directly rather than exchanged.
       */
      flowType: 'pkce',
    },
    realtime: {
      // Duo sends one small event per swipe. The default (10/sec) is generous
      // enough that a stuck loop could hammer the socket before anyone notices.
      params: { eventsPerSecond: 5 },
    },
  },
);

// Refresh tokens only while the app is foregrounded (Supabase RN guidance).
// Skipped entirely when unconfigured: there is no session to refresh, and the
// timer would retry against the placeholder host for the life of the process.
if (isSupabaseConfigured) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}
