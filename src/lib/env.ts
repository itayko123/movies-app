import { z } from 'zod';

// EXPO_PUBLIC_* vars are statically inlined by the Expo bundler, so each one
// must be referenced literally (no dynamic process.env access).
const EnvSchema = z.object({
  // Supabase is OPTIONAL and must stay that way.
  //
  // These were `.url()` / `.min(10)` and the whole module threw at import time
  // when either was absent — which in a React Native app is a white screen
  // before the first frame, with the real cause buried in a Metro log. The app
  // is fully usable without a backend (local library, local taste profile,
  // BroadcastChannel Duo), so a missing backend must degrade to local-only,
  // never take the app down. Validity is reported via `isSupabaseConfigured`
  // below and every cloud call is gated on it.
  EXPO_PUBLIC_SUPABASE_URL: z.string().default(''),
  EXPO_PUBLIC_SUPABASE_ANON_KEY: z.string().default(''),
  // TMDB stays required: there is no meaningful app without a catalogue.
  EXPO_PUBLIC_TMDB_TOKEN: z.string().min(10),
  EXPO_PUBLIC_REVENUECAT_APPLE_KEY: z.string().default(''),
  EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY: z.string().default(''),
  /**
   * Google OAuth "Web application" client id.
   *
   * Despite the name it is also what the NATIVE flow needs: it is the audience
   * Supabase validates the returned id_token against, so Android must pass it
   * as `webClientId`. Android additionally needs its own OAuth client to exist
   * in Google Cloud (matched by package name + SHA-1), but that id is never
   * referenced here.
   */
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: z.string().default(''),
  /**
   * Google OAuth "iOS" client id. Optional, and only used by a dev/production
   * build — native Google sign-in on iOS fails without it, while Android and
   * the browser fallback do not use it at all.
   */
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: z.string().default(''),
  EXPO_PUBLIC_ADMOB_DECK_ANDROID: z.string().default(''),
  EXPO_PUBLIC_ADMOB_DECK_IOS: z.string().default(''),

  // ── AI mood engine (all optional; absent ⇒ on-device fallback) ───────────
  // See src/lib/llm.ts for why the PROXY variant is the only one safe to ship.
  /** 'openai' | 'gemini' | 'anthropic'. Ignored when a proxy URL is set. */
  EXPO_PUBLIC_LLM_PROVIDER: z.string().default(''),
  /** DEV ONLY — this is inlined into the client bundle and is publicly readable. */
  EXPO_PUBLIC_LLM_API_KEY: z.string().default(''),
  /**
   * Convenience alias for the common case.
   *
   * Setting this alone is enough to turn the mood engine on: it implies
   * provider 'openai', so there is no second variable to remember. It carries
   * exactly the same exposure as EXPO_PUBLIC_LLM_API_KEY — DEV ONLY, publicly
   * readable in any shipped bundle. See src/lib/llm.ts.
   */
  EXPO_PUBLIC_OPENAI_API_KEY: z.string().default(''),
  /** Overrides the per-provider default model. */
  EXPO_PUBLIC_LLM_MODEL: z.string().default(''),
  /** Server endpoint that holds the real key. The production route. */
  EXPO_PUBLIC_LLM_PROXY_URL: z.string().default(''),
});

const parsed = EnvSchema.safeParse({
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  EXPO_PUBLIC_TMDB_TOKEN: process.env.EXPO_PUBLIC_TMDB_TOKEN,
  EXPO_PUBLIC_REVENUECAT_APPLE_KEY: process.env.EXPO_PUBLIC_REVENUECAT_APPLE_KEY,
  EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY: process.env.EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY,
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  EXPO_PUBLIC_ADMOB_DECK_ANDROID: process.env.EXPO_PUBLIC_ADMOB_DECK_ANDROID,
  EXPO_PUBLIC_ADMOB_DECK_IOS: process.env.EXPO_PUBLIC_ADMOB_DECK_IOS,
  EXPO_PUBLIC_LLM_PROVIDER: process.env.EXPO_PUBLIC_LLM_PROVIDER,
  EXPO_PUBLIC_LLM_API_KEY: process.env.EXPO_PUBLIC_LLM_API_KEY,
  EXPO_PUBLIC_OPENAI_API_KEY: process.env.EXPO_PUBLIC_OPENAI_API_KEY,
  EXPO_PUBLIC_LLM_MODEL: process.env.EXPO_PUBLIC_LLM_MODEL,
  EXPO_PUBLIC_LLM_PROXY_URL: process.env.EXPO_PUBLIC_LLM_PROXY_URL,
});

if (!parsed.success) {
  throw new Error(
    `Invalid environment configuration — copy .env.example to .env and fill it in.\n${JSON.stringify(
      parsed.error.flatten().fieldErrors,
      null,
      2,
    )}`,
  );
}

export const env = parsed.data;

/**
 * Whether a usable Supabase backend is configured.
 *
 * Checked once here rather than re-derived at each call site, so "is the cloud
 * available?" has exactly one answer in the app. A parseable http(s) URL plus a
 * non-trivial key is the most that can be established without a network round
 * trip — reachability is a separate question, handled where it matters by
 * letting the request fail and falling back (see src/lib/cloudSync.ts).
 */
export const isSupabaseConfigured: boolean = (() => {
  const url = env.EXPO_PUBLIC_SUPABASE_URL.trim();
  const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY.trim();
  if (!url || key.length < 10) return false;
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
})();

if (__DEV__ && !isSupabaseConfigured) {
  console.info(
    '[cineswipe] Supabase is not configured — running local-only. ' +
      'Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to enable cloud sync.',
  );
}
