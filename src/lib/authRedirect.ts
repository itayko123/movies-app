import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import Constants from 'expo-constants';
import { IS_EXPO_GO } from '@/lib/runtime';

/**
 * Where Supabase should send the user back to after an email link or OAuth.
 *
 * ── One helper, three very different answers ───────────────────────────────
 * There is no single correct redirect URL, and hard-coding any one of them
 * breaks the other two:
 *
 *   web            http://localhost:8090        (or the deployed origin)
 *   Expo Go        exp://192.168.x.x:8090/--/auth/callback
 *   dev/prod build cineswipe://auth/callback
 *
 * ── The physical-device trap ───────────────────────────────────────────────
 * On a real iPhone the redirect MUST carry the machine's LAN address. A
 * loopback host is meaningless there: `localhost` on the phone is the phone,
 * so Safari reports "cannot connect to the server" and the sign-in dies on the
 * doorstep. That happens in two ways, and only one of them is this file's
 * fault:
 *
 *   1. The dev server was started on loopback (a simulator-style host), so the
 *      generated URL genuinely points at localhost. Detected and warned about
 *      below.
 *   2. The generated URL is correct but is NOT in the Supabase redirect
 *      allow-list, so Supabase discards it and falls back to the project's
 *      Site URL — which on a fresh project is `http://localhost:3000`. The
 *      symptom is identical, the cause is a dashboard setting, and no amount
 *      of client code fixes it. This is the more common of the two.
 *
 * `describeRedirect()` prints both the URL and the exact allow-list entry so
 * the two cases can be told apart in a second rather than guessed at.
 */

const CALLBACK_PATH = 'auth/callback';

function isLoopback(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)(:|$)/i.test(host);
}

/**
 * `host:port` of the Metro dev server as the DEVICE resolves it.
 *
 * In Expo Go this is the LAN address the phone actually connected to, which is
 * exactly what the redirect needs. Read directly rather than trusting
 * `Linking.createURL` blindly, so the value can be inspected and validated.
 */
function devHostUri(): string | null {
  const fromConfig = Constants.expoConfig?.hostUri;
  if (fromConfig) return fromConfig;
  // Older/edge manifests expose it here instead.
  const legacy = (Constants as unknown as { expoGoConfig?: { debuggerHost?: string } })
    .expoGoConfig?.debuggerHost;
  return legacy ?? null;
}

export function authRedirectUri(): string {
  if (Platform.OS === 'web') {
    return (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
  }

  if (IS_EXPO_GO) {
    const host = devHostUri();
    // Built from the manifest host rather than from the app scheme: Expo Go
    // does not own `cineswipe://`, so a scheme URL would never come back to it.
    if (host) return `exp://${host}/--/${CALLBACK_PATH}`;
  }

  // Dev client or a store build — our own scheme, registered by app.config.js.
  return Linking.createURL(CALLBACK_PATH);
}

/**
 * Everything that must appear in
 * Supabase → Authentication → URL Configuration → Redirect URLs.
 *
 * The Expo Go entry contains the machine's current LAN IP, which changes with
 * the network — so this is generated, never written down.
 */
export function redirectAllowList(): string[] {
  const entries = new Set<string>(['cineswipe://auth/callback', 'cineswipe://**']);
  const current = authRedirectUri();
  if (current) entries.add(current);
  if (Platform.OS !== 'web') {
    const host = devHostUri();
    // Wildcard form as well: Expo Go appends its own query parameters, and an
    // exact-match allow-list entry will not cover those.
    if (host) entries.add(`exp://${host}/--/**`);
  }
  return [...entries];
}

/**
 * Logs the redirect URI immediately before it is handed to Supabase.
 *
 * Dev-only. This is the single most useful line when a redirect misbehaves:
 * it distinguishes "the app generated the wrong URL" from "the app generated
 * the right URL and Supabase refused it", which look identical from the phone.
 */
export function describeRedirect(context: string): string {
  const uri = authRedirectUri();

  if (__DEV__) {
    const host = uri.replace(/^[a-z]+:\/\//i, '');
    const loopback = Platform.OS !== 'web' && isLoopback(host);

    console.log(
      `[auth] ${context} → redirectTo = ${uri}\n` +
        `[auth] allow-list these in Supabase → Authentication → URL Configuration:\n` +
        redirectAllowList()
          .map((entry) => `         ${entry}`)
          .join('\n'),
    );

    if (loopback) {
      console.warn(
        '[auth] This redirect points at a LOOPBACK address. A physical device ' +
          'cannot reach it — "localhost" on the phone is the phone. Start Metro ' +
          'on your LAN (`npx expo start --lan`) and reload Expo Go.',
      );
    }
  }

  return uri;
}
