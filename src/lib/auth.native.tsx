import * as AppleAuthentication from 'expo-apple-authentication';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { env } from '@/lib/env';
import { IS_EXPO_GO } from '@/lib/runtime';
import { supabase } from '@/lib/supabase';
import { isProviderEnabled } from '@/lib/authProviders';
import { describeRedirect } from '@/lib/authRedirect';

/**
 * Native social-auth implementation.
 *
 * - Apple: expo-apple-authentication (an Expo module — safe to import
 *   everywhere; `isAvailableAsync` is simply false on Android).
 * - Google: TWO routes, because one is not enough.
 *
 * ── Why Google needs two routes ────────────────────────────────────────────
 * `@react-native-google-signin/google-signin` is the better experience — the
 * system account picker, no browser — but it ships native code that Expo Go
 * does not contain, so requiring it there throws "Cannot find native module"
 * and used to leave the button hidden with no way to sign in at all.
 *
 * So: use the native module when it is really present, and otherwise fall back
 * to Supabase's OAuth URL opened in an auth session, which is the flow Expo
 * documents for managed apps. The fallback needs PKCE — the browser returns a
 * `code` on the `cineswipe://` deep link and `exchangeCodeForSession` redeems
 * it (see the flowType note in src/lib/supabase.ts).
 *
 * Both routes, and Apple, resolve to the same Supabase identity.
 */

export type SignInOutcome = 'success' | 'cancelled' | 'unavailable';

/**
 * Finishes any auth session left dangling by a browser redirect. Harmless when
 * there is none, and required on Android for the tab to close cleanly.
 */
WebBrowser.maybeCompleteAuthSession();

export async function isAppleSignInAvailable(): Promise<boolean> {
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * True whenever Google is configured at all.
 *
 * No longer excludes Expo Go: the browser fallback below works there, and
 * hiding the button was worse than a slightly less slick flow — it left Expo
 * Go users with email as the only way in.
 */
export function isGoogleSignInAvailable(): boolean {
  return env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID.length > 0;
}

export async function signInWithApple(): Promise<SignInOutcome> {
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) throw new Error('no_identity_token');

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
    });
    if (error) throw error;
    return 'success';
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === 'ERR_REQUEST_CANCELED') return 'cancelled';
    throw err;
  }
}

let googleConfigured = false;

/** The native module, or null where it is not linked in (Expo Go). */
function loadGoogleModule(): {
  GoogleSignin: any;
  statusCodes: Record<string, string | number>;
} | null {
  if (IS_EXPO_GO) return null;
  try {
    return require('@react-native-google-signin/google-signin');
  } catch {
    // Present in package.json but not in this binary — a bare Expo Go-like
    // runtime, or a dev client built before the dependency was added.
    return null;
  }
}

/** Route A: the native account picker. Best UX, needs a dev/production build. */
async function googleViaNativeModule(mod: NonNullable<ReturnType<typeof loadGoogleModule>>) {
  const { GoogleSignin, statusCodes } = mod;

  if (!googleConfigured) {
    GoogleSignin.configure({
      webClientId: env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
      // iOS refuses to start without its own client id; Android ignores it.
      ...(env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
        ? { iosClientId: env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID }
        : {}),
    });
    googleConfigured = true;
  }

  try {
    await GoogleSignin.hasPlayServices();
    const response = await GoogleSignin.signIn();
    if (response.type !== 'success' || !response.data.idToken) return 'cancelled' as const;

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: response.data.idToken,
    });
    if (error) throw error;
    return 'success' as const;
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code?: string | number }).code
        : undefined;
    if (code === statusCodes.SIGN_IN_CANCELLED) return 'cancelled' as const;
    throw err;
  }
}

/**
 * Route B: Supabase's OAuth URL in a system auth session.
 *
 * `skipBrowserRedirect` is essential — without it supabase-js tries to
 * navigate the "page", which on native does nothing at all and the flow
 * silently stalls. We take the URL and drive the browser ourselves.
 */
async function googleViaBrowser(): Promise<SignInOutcome> {
  // Same pre-flight as web: an auth session opened against a disabled provider
  // shows the user a JSON error inside a browser sheet they then have to
  // dismiss, with the app none the wiser.
  if (!(await isProviderEnabled('google'))) return 'unavailable';

  // Shared with the email flow so both are allow-listed by the same entry.
  const redirectTo = describeRedirect('google oauth (browser)');

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      // Always show the chooser: without it a device with one Google account
      // signs straight back in, so "sign out and switch account" is impossible.
      queryParams: { prompt: 'select_account' },
    },
  });
  if (error) throw error;
  if (!data?.url) throw new Error('no_oauth_url');

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success') return 'cancelled';

  // PKCE: the browser hands back ?code=..., redeemed against the verifier that
  // signInWithOAuth stored on this device.
  const returned = Linking.parse(result.url);
  const code = returned.queryParams?.code;
  if (typeof code !== 'string') {
    const description = returned.queryParams?.error_description;
    throw new Error(typeof description === 'string' ? description : 'oauth_no_code');
  }

  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) throw exchangeError;
  return 'success';
}

export async function signInWithGoogle(): Promise<SignInOutcome> {
  if (!isGoogleSignInAvailable()) return 'unavailable';
  const mod = loadGoogleModule();
  return mod ? googleViaNativeModule(mod) : googleViaBrowser();
}

/**
 * Web-only concept: there is no address bar to read an OAuth error out of.
 * Native failures are thrown by signInWithGoogle instead, so this is always
 * null and exists purely to keep the two platform modules interchangeable.
 */
export function readOAuthError(): string | null {
  return null;
}

/** Official Apple button (App Review prefers it). Renders nothing on web. */
export function AppleSignInButton({ onPress }: { onPress: () => void }) {
  return (
    <AppleAuthentication.AppleAuthenticationButton
      buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
      buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
      cornerRadius={16}
      style={{ height: 54, width: '100%' }}
      onPress={onPress}
    />
  );
}
