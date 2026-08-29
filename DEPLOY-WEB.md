# Web deployment (Vercel)

The web build works because every native module in this app already has a
`.web` counterpart under `src/lib/` — `ads`, `appCheck`, `auth`, `direction`,
`posterColors`, `purchases`, `storage`. Metro's platform resolver picks those
automatically, so nothing native (MMKV, Firebase, AdMob, RevenueCat,
image-colors, Google Sign-In) is ever pulled into the browser bundle. No
polyfills or shims were needed.

## Build

```
npm run build:web      # expo export --platform web  →  dist/
npm run serve:web      # serve dist/ exactly as Vercel will (SPA fallback)
```

`app.config.js` sets `web.output: 'single'`, i.e. a client-rendered SPA. That
is why `vercel.json` rewrites every path to `/index.html` — deep links like
`/media/550` and `/duo/invite/ABC234` must reach the router rather than 404.
Vercel checks the filesystem before applying rewrites, so real assets under
`/_expo/**` are unaffected.

## Environment variables (set in Vercel → Settings → Environment Variables)

`EXPO_PUBLIC_*` values are **inlined into the JS bundle at build time**. They
are public by definition — anyone can read them out of the deployed bundle.
That is expected for these, and the same is already true of the native builds.

Required:

```
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_ANON_KEY
EXPO_PUBLIC_TMDB_TOKEN
```

Optional (features degrade cleanly when absent):

```
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID    # Google OAuth on web
EXPO_PUBLIC_REVENUECAT_*            # web build has no IAP; purchases.web.ts stubs it
EXPO_PUBLIC_ADMOB_*                 # web build shows no ads; ads.web.tsx stubs it
```

**Never set on Vercel:** `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`. These belong to the Supabase Edge Functions, not the
client. Verified absent from the built bundle; keep it that way.

## Two things that need configuring outside the repo

### 1. Supabase Auth redirect URLs

Google sign-in on web uses `supabase.auth.signInWithOAuth` with a `redirectTo`.
Supabase rejects any redirect not on its allow-list, so sign-in will fail on the
deployed domain until you add it:

Supabase Dashboard → Authentication → URL Configuration → Redirect URLs:

```
https://<your-vercel-domain>/**
https://<your-custom-domain>/**
```

### 2. App Check blocks Edge Functions on web — by design

`src/lib/appCheck.web.ts` returns `null`: App Check attests a *compiled, signed
app binary*, which a browser fundamentally cannot do. The server
(`supabase/functions/_shared/appCheck.ts`) defaults to enforcing, so every Edge
Function call from the web app is rejected with `app_check_token_missing`.

What that actually costs on web:

| Feature | Web behaviour |
|---|---|
| Swipe deck, watchlist, profile | Unaffected — TMDB + PostgREST, no Edge Function |
| Duo Mode | Unaffected — uses `join_duo_room` / `record_duo_vote` RPCs over PostgREST |
| Mood Mode | Falls back to the on-device keyword resolver; still returns real titles, just not semantic |

So the web app works; only semantic search degrades. Three ways forward:

1. **Leave it.** Web gets keyword search, native gets semantic. No new risk.
2. **Add App Check for web** via reCAPTCHA Enterprise (Firebase supports a web
   provider). Real work plus Firebase console setup, but restores parity.
3. **Do NOT** simply set `APP_CHECK_ENFORCED=false`. That disables attestation
   for *native clients too* and exposes the paid AI endpoints to anyone with the
   anon key. The rate limiter would then be the only thing between a scraper and
   your OpenAI bill.

Option 1 is the safe default and is what ships today.

## Deploy

```
npx vercel --prod
```
