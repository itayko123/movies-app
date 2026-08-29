import { supabase } from '@/lib/supabase';
import { isProviderEnabled } from '@/lib/authProviders';
import { describeRedirect } from '@/lib/authRedirect';

/**
 * Web mock/adapter for the auth layer.
 *
 * No native imports: `@react-native-google-signin/google-signin` and the
 * Apple native button never enter the web bundle. Google sign-in still works
 * on web — it goes through Supabase's browser OAuth redirect instead of the
 * native ID-token flow (enable the Google provider's redirect URL in the
 * Supabase dashboard). Apple is reported unavailable; email OTP always works.
 */

export type SignInOutcome = 'success' | 'cancelled' | 'unavailable';

export async function isAppleSignInAvailable(): Promise<boolean> {
  return false;
}

export function isGoogleSignInAvailable(): boolean {
  return true;
}

export async function signInWithApple(): Promise<SignInOutcome> {
  return 'unavailable';
}

export async function signInWithGoogle(): Promise<SignInOutcome> {
  // Ask before handing off. Once the browser navigates to /auth/v1/authorize a
  // disabled provider becomes a raw JSON page the app can no longer explain.
  if (!(await isProviderEnabled('google'))) return 'unavailable';

  const redirectTo = describeRedirect('google oauth (web)');

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      // Back to the app root, NOT the current path: the redirect target has to
      // be allow-listed in Supabase, and listing every route is unmaintainable.
      // The auth gate re-routes once the session lands.
      ...(redirectTo ? { redirectTo } : {}),
      // Always show the account chooser. Without it a browser with one Google
      // session signs straight back in and switching account is impossible.
      queryParams: { prompt: 'select_account' },
    },
  });
  if (error) throw error;

  // The browser is navigating away to Google, so nothing after this runs in a
  // normal flow. Returning 'success' only means "handed off without error";
  // the real outcome arrives on the redirect, where detectSessionInUrl
  // redeems the PKCE code and the auth listener updates the store.
  return 'success';
}

/**
 * Surfaces an OAuth failure that came back on the URL.
 *
 * Supabase reports provider errors as query/hash params on the redirect rather
 * than by rejecting anything — so a misconfigured redirect URL or a declined
 * consent screen otherwise looks exactly like "nothing happened", which is the
 * single most confusing way for this to fail.
 */
export function readOAuthError(): string | null {
  const loc = (globalThis as { location?: { search?: string; hash?: string } }).location;
  if (!loc) return null;

  for (const raw of [loc.search ?? '', (loc.hash ?? '').replace(/^#/, '')]) {
    if (!raw) continue;
    const params = new URLSearchParams(raw.replace(/^\?/, ''));
    const description = params.get('error_description') ?? params.get('error');
    if (description) return description;
  }
  return null;
}

/** The official Apple button is native-only; web renders nothing. */
export function AppleSignInButton(_props: { onPress: () => void }) {
  return null;
}
