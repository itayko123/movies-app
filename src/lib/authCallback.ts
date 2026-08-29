import { supabase, isSupabaseConfigured } from '@/lib/supabase';

/**
 * Single implementation of "turn an auth callback into a session".
 *
 * ── Why this is centralised ────────────────────────────────────────────────
 * The same callback reaches the app through TWO doors, and both fire:
 *
 *   1. `useAuthDeepLink` — the `Linking` listener at the root, which sees every
 *      incoming URL including ones that arrive while the app is already open.
 *   2. `app/auth/callback.tsx` — the Expo Router screen the deep link
 *      navigates to.
 *
 * An auth code is SINGLE USE. Whichever door redeemed it first wins, and the
 * second gets "invalid request: both auth code and code verifier should be
 * non-empty" — an alarming error for something that actually succeeded. So
 * both doors call in here, the first caller does the work, and any concurrent
 * or later caller receives the same result instead of re-spending the code.
 */

export interface AuthCompletion {
  ok: boolean;
  /** Raw provider/Supabase message, for display. */
  error?: string;
  /** False when the params carried nothing to redeem. */
  actionable: boolean;
}

export interface AuthCallbackParams {
  code?: string | null;
  token_hash?: string | null;
  token?: string | null;
  type?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  error?: string | null;
  error_description?: string | null;
}

const EMAIL_TYPES = ['magiclink', 'signup', 'email', 'invite', 'recovery', 'email_change'] as const;
type EmailType = (typeof EMAIL_TYPES)[number];

/**
 * Results are cached by credential, success OR failure.
 *
 * Caching failures too is deliberate: the credential is spent either way, so a
 * retry can only produce a more confusing error than the first one.
 */
const results = new Map<string, Promise<AuthCompletion>>();

function firstString(...values: Array<string | string[] | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  }
  return null;
}

/** Splits an incoming deep link into params, merging query AND fragment. */
export function parseAuthUrl(url: string): AuthCallbackParams {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
  const fragment = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
  const search = new URLSearchParams(`${query}${query && fragment ? '&' : ''}${fragment}`);
  return {
    code: search.get('code'),
    token_hash: search.get('token_hash'),
    token: search.get('token'),
    type: search.get('type'),
    access_token: search.get('access_token'),
    refresh_token: search.get('refresh_token'),
    error: search.get('error'),
    error_description: search.get('error_description'),
  };
}

async function redeem(params: AuthCallbackParams): Promise<AuthCompletion> {
  // A provider-side refusal arrives as parameters, not as a thrown error.
  const providerError = firstString(params.error_description, params.error);
  if (providerError) return { ok: false, error: providerError, actionable: true };

  const code = firstString(params.code);
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return { ok: !error, error: error?.message, actionable: true };
  }

  const tokenHash = firstString(params.token_hash, params.token);
  const type = firstString(params.type);
  if (tokenHash && type && (EMAIL_TYPES as readonly string[]).includes(type)) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailType,
    });
    return { ok: !error, error: error?.message, actionable: true };
  }

  const accessToken = firstString(params.access_token);
  const refreshToken = firstString(params.refresh_token);
  if (accessToken && refreshToken) {
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    return { ok: !error, error: error?.message, actionable: true };
  }

  return { ok: false, actionable: false };
}

/** Redeems an auth callback exactly once, whichever door it came through. */
export function completeAuth(params: AuthCallbackParams): Promise<AuthCompletion> {
  if (!isSupabaseConfigured) {
    return Promise.resolve({ ok: false, error: 'supabase_not_configured', actionable: false });
  }

  const credential = firstString(
    params.code,
    params.token_hash,
    params.token,
    params.access_token,
    params.error_description,
    params.error,
  );
  if (!credential) return Promise.resolve({ ok: false, actionable: false });

  const existing = results.get(credential);
  if (existing) return existing;

  const pending = redeem(params).then((result) => {
    if (__DEV__) {
      console.log(
        `[auth] callback ${result.ok ? 'succeeded' : 'failed'}` +
          (result.error ? `: ${result.error}` : ''),
      );
    }
    return result;
  });
  results.set(credential, pending);
  return pending;
}

/** Convenience wrapper for a raw deep-link URL. */
export function completeAuthUrl(url: string): Promise<AuthCompletion> {
  return completeAuth(parseAuthUrl(url));
}
