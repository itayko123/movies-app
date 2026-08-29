# CineSwipe

AI-powered movie & TV discovery: Tinder-style swipes, natural-language mood
matching over pgvector, "When It Gets Good" engagement timelines, Duo-Match,
geo streaming availability, freemium monetization, and full English (LTR) /
Hebrew (RTL) localization.

**Stack:** Expo SDK 54 (React Native 0.81, New Architecture) · Expo Router v6 ·
NativeWind v4 · Reanimated 4 (+ react-native-worklets) · Zustand + TanStack
Query + encrypted MMKV · Supabase (Postgres 15 + pgvector, Auth, Realtime,
Edge Functions) · TMDB · Claude + OpenAI embeddings · RevenueCat · AdMob ·
Firebase App Check.

## 1. Prerequisites

- Node 20+, Docker Desktop (for the local Supabase stack)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`npm i -g supabase` or scoop/brew)
- Xcode / Android Studio — this app uses native modules (MMKV, Firebase,
  AdMob, RevenueCat, image-colors) and therefore **requires a dev build; it
  does not run in Expo Go**.

## 2. Backend (local)

```bash
supabase start          # Postgres + pgvector, Auth, Realtime, Studio, Edge runtime (Docker)
supabase db reset       # applies supabase/migrations + supabase/seed.sql
```

Edge Function secrets — create `supabase/.env.local`:

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
FIREBASE_PROJECT_NUMBER=123456789012
APP_CHECK_ENFORCED=false   # local dev only; MUST be true in production
```

```bash
npm run functions:serve   # serves mood-search / duo-match / embed-media locally
```

For production: `supabase secrets set` the same keys with
`APP_CHECK_ENFORCED=true`, then `supabase functions deploy`.

## 3. App configuration

```bash
cp .env.example .env      # fill in every EXPO_PUBLIC_* value
npm install
```

Native service files (required for a device build):

- `google-services.json` / `GoogleService-Info.plist` — Firebase project with
  **App Check** enabled (Play Integrity + DeviceCheck). The Edge Functions
  reject un-attested callers in production.
- Supabase Auth: enable Apple + Google providers (see `supabase/config.toml`
  for the local equivalents). Native Google Sign-In needs the web client ID in
  `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`.
- RevenueCat: create a `premium` entitlement; the client caches it in
  **encrypted MMKV** so paying users stay ad-free offline. Configure the
  RevenueCat → Supabase webhook to keep `profiles.is_premium` authoritative.

### AI mood engine (optional)

The Mood tab turns natural language into a structured TMDB query. It works
with no configuration at all — the on-device resolver handles named titles,
topics and a curated set of emotional vibes — but an LLM handles arbitrary
phrasing far better. All four variables are optional:

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_LLM_PROXY_URL` | **Production route.** An endpoint you control that holds the real key. |
| `EXPO_PUBLIC_LLM_PROVIDER` | `openai` \| `gemini` \| `anthropic`. Direct mode only. |
| `EXPO_PUBLIC_LLM_API_KEY` | **Development only** — see the warning below. |
| `EXPO_PUBLIC_LLM_MODEL` | Overrides the per-provider default model. |

> ⚠️ **`EXPO_PUBLIC_*` variables are inlined into the client bundle.** A
> provider key placed there ships to every user and can be extracted and billed
> to you. That is a property of client-side bundling, not something the app can
> defend against. Use `EXPO_PUBLIC_LLM_PROXY_URL` for anything you ship; point
> it at the `mood-search` Edge Function, which already holds server-side keys.

The proxy contract is deliberately tiny — `POST { system, user }` →
`200 { text }` — so any backend can satisfy it.

**The model never names a title.** It only emits a *query* (genre ids, English
keyword phrases, people, bounds) which TMDB then executes, so every result
provably exists and arrives with a real poster, rating and detail link. See the
header comment in `src/lib/moodPlanner.ts`.

## 4. Run

### Expo Go (fastest way onto a real iPhone)

```bash
npx expo start
```

Scan the QR with the Camera app. Expo Go ships a **fixed** set of native
modules, so every package outside that set is lazily `require()`d behind
`IS_EXPO_GO` ([src/lib/runtime.ts](src/lib/runtime.ts)) — a top-level import
would throw `Cannot find native module '…'` while Metro is still loading the
graph and kill the app before it renders. What degrades in Expo Go:

| Feature | Expo Go | Dev/EAS build |
| --- | --- | --- |
| Storage | AsyncStorage (unencrypted) | encrypted MMKV |
| Poster-driven theming | default palette | live colour extraction |
| Ads / RevenueCat / Firebase App Check / Google Sign-In | disabled | full |

Everything else — the deck, gestures, taste engine, filters, Watchlist, Mood
Concierge, Apple Sign-In, haptics — works normally.

### Web (quick UI testing — no native code required)

```bash
npx expo start --web
```

Native SDKs (AdMob, Google Sign-In, Firebase, RevenueCat, MMKV) never enter
the web bundle: every native integration lives behind a platform-split module
(`src/lib/*.native.ts` + `src/lib/*.web.ts`) that Metro resolves per platform.
Web shows layout-faithful placeholders for ads/purchases and signs into Google
via Supabase's browser OAuth redirect.

### Android (local, Windows + Android Studio)

Requirements: JDK 17, Android Studio with an SDK + emulator, and env vars
`ANDROID_HOME` (e.g. `%LOCALAPPDATA%\Android\Sdk`) and `JAVA_HOME`.

```bash
npx expo prebuild --platform android
npx expo run:android
```

Firebase is optional at this stage — `app.config.js` only wires
`@react-native-firebase/*` in when `google-services.json` exists, so a first
build works before Firebase is configured (App Check then no-ops).

### EAS Dev Client (cloud build — no local Android/iOS toolchain)

```bash
npm i -g eas-cli
eas login
eas build --profile development --platform android   # or ios
# install the produced build on the device, then:
npx expo start --dev-client
```

### Troubleshooting / cache resets

```bash
npx expo start --clear
```

```bash
Remove-Item -Recurse -Force node_modules; npm install
```

```bash
npx expo install --check
```

## 5. Architecture notes

- **Platform shims** — native-only SDKs are isolated in paired modules:
  `ads.native.tsx`/`ads.web.tsx`, `auth.native.tsx`/`auth.web.ts`,
  `appCheck.native.ts`/`appCheck.web.ts`, `purchases.native.ts`/`purchases.web.ts`,
  `storage.native.ts`/`storage.web.ts`. Consumers import `@/lib/<name>`;
  Metro picks the file per platform, TypeScript resolves the `.native`
  variant via `moduleSuffixes`. Inside the native variants, SDK access is a
  lazy `require()` behind an Expo Go guard, so Expo Go degrades gracefully
  instead of crashing.
- **Babel** — `babel-preset-expo` auto-injects `react-native-worklets/plugin`
  (Reanimated 4). Never add a worklets/reanimated plugin manually.
- **Metro** — `unstable_conditionNames` prefers CJS so SDK 54's package-exports
  resolution can't pull `import.meta` ESM builds (zustand v5, node-vibrant)
  into the classic-script web bundle.
- **Swipe commits are not gated on animations** — `SwipeCard` starts the exit
  animation and commits the swipe on a timer of the same duration. Gating state
  on `withTiming`'s completion callback silently loses swipes when an animation
  is interrupted, and on web that callback may never fire at all (Reanimated's
  animated styles do not currently apply under react-native-web here, so on web
  the cards do not visually fly out and drag gestures are inert — the action
  buttons drive everything. Native builds animate normally).
- **Deck buttons use a prop, not a ref** — the card remounts on every swipe
  (`key={topCard.id}`), and a parent-held imperative ref is left null after a
  keyed remount, which silently killed the buttons.
- **Recommendation engine** — `recordSwipe` folds each swipe into
  `genreWeights` (like +1, superlike +2, seen +0.25, pass −0.75), split across
  the item's genres by `1/√n` so a 4-genre blockbuster can't outweigh a
  focused pick, with a 0.985 decay per swipe so the profile tracks *current*
  taste. `selectTopGenres` feeds TMDB's `with_genres`, and the buffered deck is
  re-ranked by taste on every swipe, so it adapts instantly without refetching.
- **Ads are hard-disabled in `__DEV__`** — `adsSupported()` short-circuits
  before the Google Mobile Ads SDK is ever required, so an unprovisioned dev
  client cannot crash on ad init. Verify ads in a release build.
- **Global library state** — every swipe is recorded in the Zustand `library`
  (persisted), which is what the Watchlist renders and what excludes
  already-judged cards from the deck. It works with no backend at all.
- **RTL swipe physics** — `LIKE_AXIS` in `src/components/SwipeCard.tsx` maps
  physical gestures onto the logical like/dislike axis, so in Hebrew a
  physical left-swipe *is* Like (math, not just mirrored badges). All layout
  uses logical (`start`/`end`) properties.
- **Typography** — `AppText` is the only text primitive; it applies
  `includeFontPadding: false` + `textAlignVertical: 'center'` everywhere so
  Android never clips Secular One's tall Hebrew glyphs.
- **Image memory** — deck posters are hard-capped at TMDB `w500`
  (`DECK_POSTER_SIZE`); only the detail screen loads `w780`/`original`.
- **Contrast guard** — extracted poster palettes pass through
  `src/lib/contrast.ts`; light posters force a dark scrim behind text (WCAG AA).
- **Quota enforcement** — daily swipes (50/day free) live in the `apply_swipe`
  RPC; mood searches (5/hour free) in `check_rate_limit` — both server-side.
- **Deep links** — `cineswipe://duo/invite/<id>` and
  `https://cineswipe.app/duo/invite/<id>` auto-join a Duo session
  (`app/duo/invite/[sessionId].tsx`).
- Switching language (Profile tab) flips `I18nManager` and reloads the app —
  required for native RTL re-layout.

## 6. Verification

```bash
npm run typecheck    # strict tsc
```

Manual pass: swipe all three directions in EN and HE (the like axis flips),
poster → detail transition, light-poster scrim, mood search round-trip,
duo deep-link join on a second device/simulator, airplane-mode launch as a
premium user (no ads).
