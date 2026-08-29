import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import { isSupabaseConfigured } from '@/lib/supabase';
import { completeAuthUrl } from '@/lib/authCallback';

/**
 * Completes a sign-in that arrives as a deep link.
 *
 * ── Why native needs this and web does not ─────────────────────────────────
 * On web, `detectSessionInUrl` lets supabase-js read the callback straight off
 * the address bar. There is no address bar on iOS: the magic link or OAuth
 * callback arrives as `cineswipe://` / `exp://…/--/auth/callback?code=…`
 * delivered to the app process.
 *
 * ── Overlap with app/auth/callback.tsx is intentional ──────────────────────
 * Expo Router also navigates to that path, so the screen there redeems the
 * same callback. Both go through `completeAuth`, which spends a given
 * credential exactly once — an auth code is single use, and whichever arrives
 * second must not try again.
 *
 * Keeping BOTH matters: the router only helps when the URL names a route this
 * app has, while this listener catches everything, including callbacks
 * delivered while the app is already foregrounded and any future redirect path
 * that has no screen of its own.
 *
 * Nothing here routes — `onAuthStateChange` in the root layout reacts to the
 * new session and the auth gate moves the user on.
 */
export function useAuthDeepLink(): void {
  useEffect(() => {
    // Web already handles this via detectSessionInUrl.
    if (Platform.OS === 'web' || !isSupabaseConfigured) return;

    // A link that launched the app from cold has already been delivered and
    // will never fire the listener, so it has to be read separately.
    void Linking.getInitialURL().then((url) => {
      if (url) void completeAuthUrl(url);
    });

    const subscription = Linking.addEventListener('url', ({ url }) => {
      void completeAuthUrl(url);
    });
    return () => subscription.remove();
  }, []);
}
