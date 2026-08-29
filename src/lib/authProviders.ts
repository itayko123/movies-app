import { env, isSupabaseConfigured } from '@/lib/env';

/**
 * Pre-flight check on whether a social provider is actually enabled.
 *
 * ── Why bother asking ──────────────────────────────────────────────────────
 * Starting an OAuth flow against a disabled provider does not fail politely.
 * On web the browser has already navigated to `/auth/v1/authorize` by the time
 * Supabase answers, so the user ends up staring at a bare JSON blob —
 * `{"code":400,"error_code":"validation_failed","msg":"Unsupported provider:
 * provider is not enabled"}` — on a supabase.co URL, with no way back but the
 * back button. Nothing in the app ever sees the error, so nothing can explain
 * it. That is the single most confusing way for this to fail.
 *
 * `/auth/v1/settings` is public, cheap, and reports exactly which providers are
 * live, so one request before handing off turns a dead end into a sentence.
 *
 * ── Fails OPEN, always ─────────────────────────────────────────────────────
 * If the probe errors, times out, or returns something unexpected, this
 * reports `true` and the real attempt proceeds. A diagnostic must never be the
 * reason a working sign-in is blocked.
 */
interface AuthSettings {
  external?: Record<string, boolean | undefined>;
}

let cached: AuthSettings | null = null;
let inFlight: Promise<AuthSettings | null> | null = null;

async function fetchAuthSettings(): Promise<AuthSettings | null> {
  if (!isSupabaseConfigured) return null;
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(`${env.EXPO_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
        headers: { apikey: env.EXPO_PUBLIC_SUPABASE_ANON_KEY },
      });
      if (!response.ok) return null;
      cached = (await response.json()) as AuthSettings;
      return cached;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** False only when the project positively reports the provider as disabled. */
export async function isProviderEnabled(provider: 'google' | 'apple'): Promise<boolean> {
  const settings = await fetchAuthSettings();
  if (!settings?.external) return true;
  return settings.external[provider] !== false;
}
