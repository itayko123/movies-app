// Aliased: this module already declares its own `AppState` (the store shape).
import { AppState as RNAppState, I18nManager } from 'react-native';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { coalescedStorage, flushNow as flushPersist } from '@/state/persist';
import type { Session } from '@supabase/supabase-js';
import { applyLayoutDirection } from '@/lib/direction';
import { zustandStorage } from '@/lib/storage';
import {
  syncReview as cloudSyncReview,
  syncStreak as cloudSyncStreak,
  syncSwipe as cloudSyncSwipe,
  syncQuest as cloudSyncQuest,
  syncTaste as cloudSyncTaste,
  type RemoteSnapshot,
} from '@/lib/cloudSync';
import {
  cinephileLevel,
  generateDailyQuests,
  QUEST_XP,
  type DailyQuest,
  type QuestKind,
} from '@/lib/quests';
import type { RegionCode } from '@/lib/tmdb';
import type { Profile } from '@/types/db';
import type { MediaItemRow, SwipeDirection } from '@/types/media';

export type Locale = 'en' | 'he';
export type MediaFormat = 'movie' | 'tv' | 'both';

/** Colors extracted from the focused poster, driving the live theme. */
export interface Palette {
  /** Dominant poster color — backgrounds, glows. */
  primary: string;
  /** Secondary/vibrant poster color — accents. */
  secondary: string;
  /** True when `primary` is too light for white text (scrim required). */
  isLight: boolean;
  /** Poster URL this palette was extracted from. */
  posterUrl: string | null;
}

export const DEFAULT_PALETTE: Palette = {
  primary: '#00B8D9',
  secondary: '#00B8D9',
  isLight: false,
  posterUrl: null,
};

/** What the user asked for during onboarding. */
export interface Preferences {
  /** TMDB genre names, e.g. ['Comedy', 'Science Fiction']. Empty = no filter. */
  genres: string[];
  mediaType: MediaFormat;
}

/** One recorded swipe, with enough of the item to render it offline. */
export interface LibraryEntry {
  item: MediaItemRow;
  direction: SwipeDirection;
  /** Epoch ms — drives "most recent first" ordering. */
  at: number;
}

/** One title both partners matched on, kept after the session ends. */
export interface DuoMatch {
  media_item_id: string;
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  title: string;
  poster_path: string | null;
  /** 0–1 agreement score from the duo_match RPC. */
  score: number;
  /** Epoch ms the match was revealed. */
  at: number;
}

export type PersonRole = 'director' | 'cast';

/** One learned affinity for a specific person, on a specific side of the camera. */
export interface PersonAffinity {
  /** TMDB person id — what `with_cast` / `with_crew` actually take. */
  id: number;
  name: string;
  /**
   * Keyed separately from the same person's other role.
   *
   * TMDB matches cast and crew on DIFFERENT discover parameters, so "I like
   * Clint Eastwood's directing" and "I like watching Clint Eastwood" have to
   * stay distinguishable or the query cannot be built correctly.
   */
  role: PersonRole;
  profile_path: string | null;
  weight: number;
  /** Distinct swiped titles this credit appeared on — the showable number. */
  count: number;
}

/** Credits extracted from one title, ready to fold into the taste vector. */
export interface TitleCreditsInput {
  director: { id: number; name: string; profile_path: string | null } | null;
  cast: Array<{ id: number; name: string; profile_path: string | null }>;
}

export function personKey(role: PersonRole, id: number): string {
  return `${role}:${id}`;
}

/** One review the user wrote. Keyed under `mediaType:tmdbId`. */
export interface Review {
  id: string;
  /** 1–5 stars. */
  rating: number;
  body: string;
  at: number;
}

/**
 * Daily swipe streak.
 *
 * `lastDay` is a LOCAL calendar day string (YYYY-MM-DD), not a timestamp.
 * Streaks are a human idea — "did I use it yesterday?" — and comparing raw
 * epoch differences gets that wrong at both ends: 23:59 → 00:01 is six minutes
 * but two days, while 09:00 → 08:00 the next morning is 23 hours and also two
 * days. Comparing calendar days is the only thing that matches what the user
 * believes happened.
 */
export interface Streak {
  current: number;
  longest: number;
  /** YYYY-MM-DD of the last day with at least one swipe, or null. */
  lastDay: string | null;
}

/** Local calendar day, timezone-correct (never toISOString, which is UTC). */
export function localDayKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Whole days between two day keys. */
function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const a = Date.UTC(fy ?? 0, (fm ?? 1) - 1, fd ?? 1);
  const b = Date.UTC(ty ?? 0, (tm ?? 1) - 1, td ?? 1);
  return Math.round((b - a) / 86_400_000);
}

/** Manual overrides from the Discover filter bar. `null` = follow preferences. */
export interface DeckFilters {
  format: MediaFormat | null;
  /** A single genre name pinned from the pill row. */
  genre: string | null;
}

// ── Taste model ────────────────────────────────────────────────────────
//
// Weight deltas per swipe direction. A dislike must not fully cancel a like
// (people pass on things for reasons unrelated to genre), and "seen it" is a
// weak positive because watching something is evidence of interest.
const TASTE_DELTA: Record<SwipeDirection, number> = {
  superlike: 2,
  like: 1,
  seen: 0.25,
  dislike: -0.75,
};

/**
 * Applied to every existing weight before each new swipe is folded in, so the
 * profile tracks *current* taste rather than accumulating forever. At 0.985 a
 * genre's influence roughly halves over ~45 swipes.
 */
const TASTE_DECAY = 0.985;

/** Weights are clamped so no single genre can dominate the whole deck. */
const WEIGHT_CEILING = 12;
const WEIGHT_FLOOR = -6;

/** Below this a genre is considered noise and excluded from queries. */
const MIN_POSITIVE_WEIGHT = 0.75;

// ── People: the second half of the taste vector ────────────────────────────
//
// Genre alone is a blunt instrument. "Drama" describes a third of the
// catalogue and says nothing about why a particular Drama landed; the director
// and the faces on screen are what people actually mean when they say they
// liked something. So every positive swipe also folds in the title's
// authorship.
//
// People are weighted on a SEPARATE scale from genres and are deliberately
// scarcer. A genre recurs on nearly every card, so genre weights climb fast;
// a given actor might appear twice in a hundred swipes. Reusing the genre
// thresholds would mean no person ever cleared the bar.

/**
 * Share of a swipe's signal each credit receives.
 *
 * The director takes the full delta: one person chose everything about the
 * film, so it is the highest-information credit available. Cast decays down
 * the billing order, because third billing is a much weaker claim on why a
 * viewer liked something than the lead is.
 */
const DIRECTOR_SHARE = 1;
const CAST_SHARES = [0.7, 0.5, 0.35] as const;

const PERSON_CEILING = 8;
const PERSON_FLOOR = -4;

/**
 * Weight at which a person is strong enough to drive a query.
 *
 * Calibrated against the shares above: 1.2 means roughly "two liked titles
 * with this person as lead or director, or one super-like". Any lower and a
 * single co-incidental co-star would spawn a whole recommendation shelf.
 */
const MIN_PERSON_WEIGHT = 1.2;

/**
 * Cap on remembered people.
 *
 * Every swipe contributes up to four (a director + three cast), so this map
 * grows four times faster than the genre map and, unlike genres, has no fixed
 * vocabulary to bound it. Without a cap the persisted store would grow without
 * limit. Pruning keeps the strongest signals in both directions.
 */
const MAX_TRACKED_PEOPLE = 120;

/**
 * Streak lengths worth celebrating.
 *
 * Sparse on purpose. A celebration every single day trains the user to dismiss
 * it, which costs the one moment that should actually feel like something.
 */
export const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100];

/**
 * Swipes before the learned profile is allowed to override the onboarding
 * picks.
 *
 * Until this many swipes exist, the onboarding choices are a HARD filter. The
 * previous build seeded the taste weights from onboarding and then let the
 * taste path drive immediately, which read as "the app ignored what I chose" —
 * it had no evidence yet, so it was really just re-deriving the same genres
 * through a lossier route.
 */
export const TASTE_TAKEOVER_SWIPES = 12;

/**
 * Parses `profiles.taste_profile` back into weights.
 *
 * The column is free-form jsonb written by a previous client version, so every
 * field is treated as hostile: non-finite numbers, nested objects and inherited
 * keys all get dropped rather than reaching the ranking arithmetic, where a
 * single NaN would silently poison every comparison it touches.
 */
function readRemoteTaste(
  raw: unknown,
): { weights: Record<string, number>; swipes: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = (raw as { liked_genres?: unknown }).liked_genres;
  if (typeof source !== 'object' || source === null) return null;

  const weights: Record<string, number> = {};
  for (const [genre, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    weights[genre] = clamp(value, WEIGHT_FLOOR, WEIGHT_CEILING);
  }
  if (Object.keys(weights).length === 0) return null;

  const swipesRaw = (raw as { swipes?: unknown }).swipes;
  const swipes =
    typeof swipesRaw === 'number' && Number.isFinite(swipesRaw) && swipesRaw >= 0
      ? Math.floor(swipesRaw)
      : 0;

  return { weights, swipes };
}

// ── Quest progress ─────────────────────────────────────────────────────
//
// Kept as a free function rather than a store action so `recordSwipe` can fold
// quest progress into the SAME `set` call that records the swipe. Two separate
// updates would render an intermediate frame in which the swipe had landed but
// the quest had not, which is exactly the sort of one-frame inconsistency this
// codebase has spent three runs removing.

interface QuestSlice {
  questDay: string | null;
  quests: DailyQuest[];
  xp: number;
  levelCelebration: number | null;
}

interface QuestEvent {
  kind: QuestKind;
  amount: number;
}

/**
 * Applies quest events for `today`, rolling the set over if the day changed,
 * and awards XP for anything that completes.
 *
 * Returns the completed kinds as well, so the caller can tell the server about
 * exactly those — the server pays its own XP, and telling it about a quest that
 * did not complete would be a wasted round trip.
 */
function applyQuests(
  slice: QuestSlice,
  today: string,
  events: QuestEvent[],
): QuestSlice & { completed: QuestKind[] } {
  // A new calendar day replaces the set outright. Carrying yesterday's
  // progress forward would let someone bank a near-complete quest overnight.
  const rolled = slice.questDay !== today;
  const quests = rolled ? generateDailyQuests(today) : slice.quests.map((q) => ({ ...q }));

  const completed: QuestKind[] = [];
  for (const event of events) {
    const quest = quests.find((q) => q.type === event.kind);
    if (!quest || quest.completed) continue;
    quest.progress = Math.min(quest.progress + event.amount, quest.goal);
    if (quest.progress >= quest.goal) {
      quest.completed = true;
      completed.push(quest.type);
    }
  }

  const xp = slice.xp + completed.length * QUEST_XP;
  const previousLevel = cinephileLevel(slice.xp);
  const nextLevel = cinephileLevel(xp);

  return {
    questDay: today,
    quests,
    xp,
    levelCelebration: nextLevel > previousLevel ? nextLevel : slice.levelCelebration,
    completed,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ── Batched taste learning ─────────────────────────────────────────────────
//
// A swipe splits into two halves with very different urgency:
//
//   • the LIBRARY entry — what the Liked / To Watch / Seen tabs read. Must
//     land synchronously or the tabs look broken (they did, twice).
//   • the TASTE math — decay across every learned genre, streak arithmetic,
//     quest progress, XP, level-ups. Nothing on screen depends on it inside a
//     few hundred milliseconds.
//
// Only the first is on the critical path, so only the first runs there. The
// rest is queued and applied in ONE `set` per batch, which also means one
// persisted write per batch instead of one per swipe.
//
// ── What batching does and does NOT optimise ───────────────────────────────
// It collapses N state updates into one, and with them N persisted writes into
// one. That is the entire win, and it is a large one.
//
// It deliberately does NOT approximate the taste maths. An earlier attempt
// folded the per-swipe decay into a single bulk exponent (TASTE_DECAY ** n)
// with a per-entry age discount, which looks equivalent and is not: the
// sequential form clamps to [WEIGHT_FLOOR, WEIGHT_CEILING] and prunes weights
// under 0.05 after EVERY swipe, so the two diverge whenever either bites.
// Checked over 20,000 randomised batches, the "clever" version was off by up
// to 0.18 and disagreed about which genres existed at all.
//
// It was also optimising the wrong thing. The decay loop over every learned
// genre measures 0.004ms — the per-swipe cost was never here, it was in
// serialising the store for persistence (0.4-3.1ms and rising with history).
// So the loop below is the original sequential algorithm, unchanged and
// therefore exactly correct, just run once per batch instead of once per set.

interface QueuedSwipe {
  item: MediaItemRow;
  direction: SwipeDirection;
}

/**
 * Strips a swiped title down to what the history actually needs.
 *
 * `library` is the single biggest thing in the persisted blob, because it
 * keeps one row per swipe forever and each row carried the title's full
 * `overview` — a 200-400 character synopsis nothing in the app reads back.
 * At a thousand swipes that alone was most of a half-megabyte being
 * re-serialised on write.
 *
 * ── What is kept, and why it is more than "id + title + poster" ────────────
 * The obvious minimal set would break two features that read the history:
 *
 *   • `genres`       — selectGenreStats and the For You shelves derive every
 *                      "because you liked 5 sci-fi titles" claim from these.
 *                      Drop them and the taste explanations silently empty out.
 *   • `release_year` — the Watchlist's "by year" sort has nothing to sort on.
 *
 * Both are a number and a short array, so they cost almost nothing. What
 * actually costs is prose and unused paths, and those are what go.
 */
function compactForLibrary(item: MediaItemRow): MediaItemRow {
  return {
    id: item.id,
    tmdb_id: item.tmdb_id,
    media_type: item.media_type,
    title: item.title,
    poster_path: item.poster_path,
    vote_average: item.vote_average,
    genres: item.genres,
    release_year: item.release_year,
    // Dropped: heavy or unread in any library view.
    overview: null,
    backdrop_path: null,
    original_title: null,
    popularity: null,
    // KEPT, unlike the other trimmed fields. It is a single integer, so the
    // "heavy" argument that justifies dropping the overview/backdrop strings
    // does not apply, and total watch time cannot be computed without it.
    // Deliberately NOT shown anywhere yet: a lifetime figure covering only
    // titles saved after this change would understate it badly. This starts
    // the data accruing so the stat can be honest whenever it does land.
    runtime_minutes: item.runtime_minutes,
    origin_country: [],
  };
}

/** Swipes recorded but not yet folded into the taste profile. */
let tasteQueue: QueuedSwipe[] = [];
let tasteTimer: ReturnType<typeof setTimeout> | null = null;

/** Flush once this many swipes are waiting, so a fast run never lags far behind. */
const TASTE_BATCH_SIZE = 5;
/** …or this long after the last swipe, so a single swipe is not left pending. */
const TASTE_FLUSH_MS = 220;

function scheduleTasteFlush(): void {
  if (tasteQueue.length >= TASTE_BATCH_SIZE) {
    flushTasteQueue();
    return;
  }
  if (tasteTimer) return;
  tasteTimer = setTimeout(flushTasteQueue, TASTE_FLUSH_MS);
}

/**
 * Folds every queued swipe into the taste profile in a single update.
 *
 * Exported so the app can force it at moments where "a bit later" is not good
 * enough — backgrounding, sign-out, account deletion.
 */
export function flushTasteQueue(): void {
  if (tasteTimer) {
    clearTimeout(tasteTimer);
    tasteTimer = null;
  }
  if (tasteQueue.length === 0) return;

  const batch = tasteQueue;
  tasteQueue = [];
  const today = localDayKey();

  // Quest deltas depend only on the swipes, never on state.
  const events: QuestEvent[] = [{ kind: 'swipe', amount: batch.length }];
  let watchlistCount = 0;
  let regionCount = 0;
  for (const entry of batch) {
    if (entry.direction !== 'superlike') continue;
    watchlistCount += 1;
    if (entry.item.origin_country.includes('IL')) regionCount += 1;
  }
  if (watchlistCount > 0) events.push({ kind: 'watchlist', amount: watchlistCount });
  if (regionCount > 0) events.push({ kind: 'region', amount: regionCount });

  useAppStore.setState((state) => {
    /*
      The original per-swipe algorithm, replayed over the batch.

      Decay-then-apply, once per queued swipe, with the clamp and the 0.05
      prune in their original positions — so a batch of five produces bit-for-bit
      what five separate calls produced. Splitting each swipe's delta across its
      genres by 1/√n still keeps a 4-genre blockbuster from outweighing a
      focused 1-genre pick.
    */
    let nextWeights: Record<string, number> = state.genreWeights;
    for (const entry of batch) {
      const genres = entry.item.genres;
      const delta = TASTE_DELTA[entry.direction];
      const share = genres.length > 0 ? delta / Math.sqrt(genres.length) : 0;

      const stepped: Record<string, number> = {};
      for (const [genre, weight] of Object.entries(nextWeights)) {
        const decayed = weight * TASTE_DECAY;
        // Drop weights that have decayed into irrelevance.
        if (Math.abs(decayed) >= 0.05) stepped[genre] = decayed;
      }
      for (const genre of genres) {
        stepped[genre] = clamp((stepped[genre] ?? 0) + share, WEIGHT_FLOOR, WEIGHT_CEILING);
      }
      nextWeights = stepped;
    }

    // ── Streak ──────────────────────────────────────────────────────────
    // Advances at most once per calendar day, so a batch is no different from
    // a single swipe here.
    const previous = state.streak;
    let streak = previous;
    let celebration = state.streakCelebration;
    if (previous.lastDay !== today) {
      const gap = previous.lastDay ? daysBetween(previous.lastDay, today) : Infinity;
      const current = gap === 1 ? previous.current + 1 : 1;
      streak = { current, longest: Math.max(previous.longest, current), lastDay: today };
      if (STREAK_MILESTONES.includes(current)) celebration = current;
    }

    const questState = applyQuests(state, today, events);

    return {
      genreWeights: nextWeights,
      tasteSwipeCount: state.tasteSwipeCount + batch.length,
      streak,
      streakCelebration: celebration,
      questDay: questState.questDay,
      quests: questState.quests,
      xp: questState.xp,
      levelCelebration: questState.levelCelebration,
    };
  });

  // Cloud, after the fact and never awaited.
  const after = useAppStore.getState();
  if (after.streak.lastDay === today) cloudSyncStreak(today);
  for (const event of events) cloudSyncQuest(today, event.kind, event.amount);
  cloudSyncTaste(after.genreWeights, after.tasteSwipeCount);
}

/**
 * Premium is unlocked in development so every gated surface — Concierge,
 * Duo-Match, deep stats, unlimited swipes — is reachable without a paywall or
 * a RevenueCat sandbox account.
 *
 * `__DEV__` is compiled to `false` in release builds, so this cannot ship
 * enabled. The server-side `apply_swipe` quota is still authoritative in
 * production regardless of what this client flag says.
 */
export const DEV_PREMIUM = __DEV__;

interface AppState {
  // ── Session ──────────────────────────────────────────────────────────
  session: Session | null;
  profile: Profile | null;
  /** True once the initial getSession() resolved (gates the auth redirect). */
  sessionLoaded: boolean;
  setSession: (session: Session | null) => void;
  setProfile: (profile: Profile | null) => void;
  setSessionLoaded: () => void;

  // ── Localization ─────────────────────────────────────────────────────
  locale: Locale;
  /**
   * Switches language and flips the native layout direction.
   * Returns true when an app reload is required for RTL/LTR to fully apply.
   */
  setLocale: (locale: Locale) => boolean;

  // ── Dynamic theme ────────────────────────────────────────────────────
  palette: Palette;
  setPalette: (palette: Palette) => void;
  resetPalette: () => void;

  // ── Preferences (cold-start onboarding) ──────────────────────────────
  /** null until onboarding completes — the root layout gates on this. */
  preferences: Preferences | null;
  setPreferences: (preferences: Preferences) => void;
  /**
   * Sends the user back through onboarding.
   *
   * Nulling `preferences` is not cosmetic — it is what makes the trip possible
   * at all. The routing gate in app/_layout.tsx replaces /onboarding with / on
   * every render where preferences is non-null, so navigating there without
   * clearing first bounces straight back and the button looks dead.
   *
   * The learned taste profile is deliberately KEPT: the user asked to redo
   * their picks, not to be forgotten. Onboarding re-seeds weights on top of
   * what is already there (see setPreferences).
   */
  clearPreferences: () => void;

  // ── Region (top-level content origin) ────────────────────────────────
  /**
   * Which country's output to show. A first-class axis, above genre and format:
   * it composes with both ("Korean thrillers") and it is the one filter that
   * must NEVER be relaxed to keep the deck full.
   */
  region: RegionCode;
  setRegion: (region: RegionCode) => void;

  // ── Discover filter bar ──────────────────────────────────────────────
  deckFilters: DeckFilters;
  setDeckFormat: (format: MediaFormat | null) => void;
  setDeckGenre: (genre: string | null) => void;
  clearDeckFilters: () => void;

  // ── Taste profile (the recommendation engine's memory) ───────────────
  /** Genre name → weight. Positive attracts, negative repels. */
  genreWeights: Record<string, number>;
  tasteSwipeCount: number;
  /**
   * `role:tmdbId` → learned affinity for a director or actor.
   *
   * The other half of the taste vector. Filled in asynchronously after a
   * swipe, because credits are a second TMDB request and must never sit in
   * front of the gesture — see learnTitleCredits in src/lib/taste.ts.
   */
  personWeights: Record<string, PersonAffinity>;
  /**
   * Folds one title's credits into the person vector.
   *
   * `direction` decides the sign and magnitude using the same table as genres,
   * so a dislike teaches the profile just as a like does — only more weakly.
   */
  learnCredits: (credits: TitleCreditsInput, direction: SwipeDirection) => void;

  // ── Library: every swipe the user has made ───────────────────────────
  /**
   * Keyed by media item id. Source of truth for the Watchlist and for
   * excluding already-judged cards. On native it mirrors the `swipes` table;
   * on web it IS the database.
   */
  library: Record<string, LibraryEntry>;
  /** Records the swipe AND folds the item's genres into the taste profile. */
  recordSwipe: (item: MediaItemRow, direction: SwipeDirection) => void;
  /**
   * Moves an ALREADY-JUDGED title between lists WITHOUT re-weighting taste.
   *
   * The distinction from `recordSwipe` is the whole point. A swipe is a fresh
   * opinion and should teach the recommendation engine. Dragging a title you
   * already saved from "To Watch" into "Seen" is bookkeeping about a judgement
   * you already made — running it back through the taste queue would count the
   * same title's genres twice and quietly skew the profile toward whatever the
   * user happens to tidy up most often.
   *
   * Still syncs to the cloud: the change is real, it just is not new evidence.
   */
  reclassify: (id: string, direction: SwipeDirection) => void;
  removeFromLibrary: (id: string) => void;
  clearLibrary: () => void;

  // ── Reviews ──────────────────────────────────────────────────────────
  /** `mediaType:tmdbId` → the user's reviews for that title. */
  reviews: Record<string, Review[]>;
  addReview: (mediaKey: string, rating: number, body: string) => void;
  removeReview: (mediaKey: string, reviewId: string) => void;

  // ── Gamification ─────────────────────────────────────────────────────
  streak: Streak;
  /**
   * True for one render after a streak milestone, so the UI can celebrate
   * once and not on every subsequent swipe of the same day.
   */
  streakCelebration: number | null;
  clearStreakCelebration: () => void;

  // ── Quests, XP and cinephile level ───────────────────────────────────
  /** Total XP earned. The level is always derived, never stored separately. */
  xp: number;
  /** Level reached, set for one render after a level-up. */
  levelCelebration: number | null;
  clearLevelCelebration: () => void;
  /** Day key the current quest set belongs to; null before the first launch. */
  questDay: string | null;
  quests: DailyQuest[];
  /** Rolls the quest set over if the calendar day changed. Safe to call often. */
  ensureQuests: () => void;
  /** Adds progress to one quest kind, awarding XP if it completes. */
  advanceQuest: (kind: QuestKind, amount?: number) => void;

  /** Folds a cloud snapshot into local state (new device, reinstall). */
  applyRemoteSnapshot: (snapshot: RemoteSnapshot) => void;

  // ── First-run tutorial ───────────────────────────────────────────────
  hasSeenTutorial: boolean;
  completeTutorial: () => void;

  // ── Duo-Match ────────────────────────────────────────────────────────
  /**
   * Matches revealed in past Duo sessions, newest first.
   *
   * Persisted deliberately: a Duo session is ephemeral (Realtime channel, one
   * partner, one reveal) but its RESULT is the whole point of the feature.
   * Previously the picks lived only in the hook's state and vanished the moment
   * the tab unmounted, so "we found 3 films you'll both love" was gone before
   * anyone could act on it.
   */
  duoMatches: DuoMatch[];
  addDuoMatches: (matches: DuoMatch[]) => void;
  clearDuoMatches: () => void;
  /** True once the animated Duo explainer has been dismissed. */
  hasSeenDuoIntro: boolean;
  completeDuoIntro: () => void;

  // ── Session-scoped dedupe ────────────────────────────────────────────
  /**
   * Every `mediaType:tmdbId` the deck has surfaced this session.
   *
   * `library` only records SWIPED items, so it cannot stop a title that is
   * merely on screen (or was dropped when a filter changed) from being fetched
   * again by a later page or a different genre lane — a title tagged both War
   * and Drama is returned by both lanes. This is deliberately NOT persisted:
   * it is a render-level guard, and persisting it would permanently hide
   * titles the user never actually judged.
   */
  seenIds: Set<string>;
  markSeen: (keys: string[]) => void;
  clearSeen: () => void;

  // ── Entitlements (persisted to ENCRYPTED MMKV → offline truth) ───────
  isPremium: boolean;
  premiumCheckedAt: number | null;
  swipesRemaining: number | null;
  deckLocked: boolean;
  setPremium: (premium: boolean) => void;
  setSwipesRemaining: (remaining: number | null) => void;
  setDeckLocked: (locked: boolean) => void;

  /** Sign-out reset: drops identity and personal data, keeps locale. */
  reset: () => void;
  /** Factory reset: everything above plus onboarding, for testing cold start. */
  resetAll: () => void;
}

const INITIAL_FILTERS: DeckFilters = { format: null, genre: null };

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      session: null,
      profile: null,
      sessionLoaded: false,
      setSession: (session) => set({ session }),
      setProfile: (profile) => set({ profile }),
      setSessionLoaded: () => set({ sessionLoaded: true }),

      /**
       * Hebrew is the DEFAULT, not a setting to be discovered.
       *
       * The audience is Israeli, so a first launch that opens in English makes
       * the user's own language look like the alternative. Onboarding — the
       * very first screen anyone sees — must already be Hebrew and RTL. Anyone
       * who prefers English switches once in Profile and the choice persists.
       */
      locale: 'he',
      setLocale: (locale) => {
        set({ locale });
        // Platform-split: native flips the layout pass, web sets the document
        // direction. See src/lib/direction.* — doing this inline was the bug
        // that left the web build rendering Hebrew inside an LTR document.
        return applyLayoutDirection(locale);
      },

      palette: DEFAULT_PALETTE,
      setPalette: (palette) => set({ palette }),
      resetPalette: () => set({ palette: DEFAULT_PALETTE }),

      preferences: null,
      setPreferences: (preferences) =>
        set((state) => ({
          preferences,
          // Seed the taste profile from onboarding so the very first deck is
          // already personalised instead of waiting for swipe history.
          genreWeights: preferences.genres.reduce<Record<string, number>>(
            (acc, genre) => {
              acc[genre] = Math.max(acc[genre] ?? 0, 2);
              return acc;
            },
            { ...state.genreWeights },
          ),
        })),
      // Also clears the pinned genre/format: those were chosen to narrow the
      // OLD picks, and leaving them applied would silently constrain the deck
      // the user is about to rebuild.
      clearPreferences: () => set({ preferences: null, deckFilters: INITIAL_FILTERS }),

      region: 'GLOBAL',
      setRegion: (region) => set({ region }),

      deckFilters: INITIAL_FILTERS,
      setDeckFormat: (format) =>
        set((state) => ({ deckFilters: { ...state.deckFilters, format } })),
      setDeckGenre: (genre) =>
        set((state) => ({ deckFilters: { ...state.deckFilters, genre } })),
      clearDeckFilters: () => set({ deckFilters: INITIAL_FILTERS }),

      genreWeights: {},
      tasteSwipeCount: 0,

      personWeights: {},
      learnCredits: (credits, direction) =>
        set((state) => {
          const delta = TASTE_DELTA[direction];
          if (delta === 0) return {};

          /** [person, share] pairs for this title, strongest credit first. */
          const contributions: Array<[TitleCreditsInput['cast'][number], PersonRole, number]> = [];
          if (credits.director) contributions.push([credits.director, 'director', DIRECTOR_SHARE]);
          credits.cast.slice(0, CAST_SHARES.length).forEach((person, index) => {
            contributions.push([person, 'cast', CAST_SHARES[index] ?? 0]);
          });
          if (contributions.length === 0) return {};

          // Decay first, exactly as genres do, so the person vector tracks
          // current taste instead of accumulating a permanent record of every
          // actor the user ever swiped past.
          const next: Record<string, PersonAffinity> = {};
          for (const [key, affinity] of Object.entries(state.personWeights)) {
            const decayed = affinity.weight * TASTE_DECAY;
            if (Math.abs(decayed) >= 0.05) next[key] = { ...affinity, weight: decayed };
          }

          for (const [person, role, share] of contributions) {
            const key = personKey(role, person.id);
            const existing = next[key];
            next[key] = {
              id: person.id,
              name: person.name,
              role,
              // A later credit may carry a photo an earlier one lacked.
              profile_path: person.profile_path ?? existing?.profile_path ?? null,
              weight: clamp(
                (existing?.weight ?? 0) + delta * share,
                PERSON_FLOOR,
                PERSON_CEILING,
              ),
              count: (existing?.count ?? 0) + 1,
            };
          }

          // Prune by absolute weight: a strong dislike is as worth keeping as
          // a strong like, since both steer the deck.
          const entries = Object.entries(next);
          if (entries.length <= MAX_TRACKED_PEOPLE) return { personWeights: next };
          return {
            personWeights: Object.fromEntries(
              entries
                .sort((a, b) => Math.abs(b[1].weight) - Math.abs(a[1].weight))
                .slice(0, MAX_TRACKED_PEOPLE),
            ),
          };
        }),

      library: {},
      /**
       * Records a swipe. Deliberately does the SMALLEST possible amount of work.
       *
       * One object spread and one `set` — that is the whole synchronous cost,
       * and it is the only part the user can perceive, because the Liked / To
       * Watch / Seen tabs read `library` directly. Everything else about a
       * swipe (taste decay, streak, quests, XP) is queued for a batch that runs
       * between gestures; see flushTasteQueue.
       */
      recordSwipe: (item, direction) => {
        set((state) => ({
          library: {
            ...state.library,
            // Compacted on the way in — see compactForLibrary. The FULL item
            // still goes to the taste queue and the cloud below, so nothing
            // downstream of the swipe loses information; only the permanent
            // on-device history is slimmed.
            [item.id]: { item: compactForLibrary(item), direction, at: Date.now() },
          },
        }));

        // Enqueues and returns; the cloud queue drains on its own timer.
        cloudSyncSwipe(item, direction);

        // Hand the expensive half to the batch. Keeps the uncompacted item:
        // the quest rules read origin_country, which the stored copy drops.
        tasteQueue.push({ item, direction });
        scheduleTasteFlush();
      },
      reclassify: (id, direction) => {
        const entry = get().library[id];
        // Nothing to move. Deliberately NOT a fallback to recordSwipe: this
        // action's contract is "re-file something already filed", and silently
        // creating an entry here would teach taste from a UI that promised not
        // to.
        if (!entry) return;
        if (entry.direction === direction) return;

        set((state) => ({
          library: {
            ...state.library,
            // `at` is refreshed so the title surfaces at the top of its new
            // list — the user just acted on it, and finding it buried under
            // months-old saves would read as the move having failed.
            [id]: { ...entry, direction, at: Date.now() },
          },
        }));

        // The server still needs to know. `entry.item` is the compacted copy,
        // which keeps the identity fields the sync payload is built from.
        cloudSyncSwipe(entry.item, direction);

        // NO tasteQueue push. That omission is the entire feature.
      },
      removeFromLibrary: (id) =>
        set((state) => {
          const { [id]: _removed, ...rest } = state.library;
          return { library: rest };
        }),
      clearLibrary: () => set({ library: {} }),

      reviews: {},
      addReview: (mediaKey, rating, body) => {
        const today = localDayKey();
        const stars = clamp(Math.round(rating), 1, 5);
        const text = body.trim();

        // A review always counts once; four stars or better also satisfies the
        // "leave a glowing review" quest.
        const events: QuestEvent[] = [{ kind: 'review', amount: 1 }];
        if (stars >= 4) events.push({ kind: 'high_rating', amount: 1 });

        set((state) => {
          const review: Review = {
            id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
            rating: stars,
            body: text,
            at: Date.now(),
          };
          const questState = applyQuests(state, today, events);
          return {
            reviews: {
              ...state.reviews,
              [mediaKey]: [review, ...(state.reviews[mediaKey] ?? [])],
            },
            questDay: questState.questDay,
            quests: questState.quests,
            xp: questState.xp,
            levelCelebration: questState.levelCelebration,
          };
        });

        cloudSyncReview(mediaKey, stars, text);
        for (const event of events) cloudSyncQuest(today, event.kind, event.amount);
      },
      removeReview: (mediaKey, reviewId) =>
        set((state) => ({
          reviews: {
            ...state.reviews,
            [mediaKey]: (state.reviews[mediaKey] ?? []).filter((r) => r.id !== reviewId),
          },
        })),

      streak: { current: 0, longest: 0, lastDay: null },
      streakCelebration: null,
      clearStreakCelebration: () => set({ streakCelebration: null }),

      xp: 0,
      levelCelebration: null,
      clearLevelCelebration: () => set({ levelCelebration: null }),
      questDay: null,
      quests: [],
      ensureQuests: () =>
        set((state) => {
          const today = localDayKey();
          if (state.questDay === today && state.quests.length > 0) return {};
          return { questDay: today, quests: generateDailyQuests(today) };
        }),
      advanceQuest: (kind, amount = 1) => {
        const today = localDayKey();
        set((state) => {
          const next = applyQuests(state, today, [{ kind, amount }]);
          return {
            questDay: next.questDay,
            quests: next.quests,
            xp: next.xp,
            levelCelebration: next.levelCelebration,
          };
        });
        cloudSyncQuest(today, kind, amount);
      },

      /**
       * Folds a cloud snapshot into local state.
       *
       * ── What can and cannot be restored ──────────────────────────────
       * `swipes` rows carry only an id, a type and a direction, so they can
       * rebuild the "already judged" set but NOT full library entries — genre
       * lists, runtimes and overviews are TMDB properties that were never
       * uploaded and are re-hydrated the next time the title is fetched.
       * `watchlist` rows do carry a title and poster, so saved titles come
       * back with something to render immediately.
       *
       * ── Merge direction ──────────────────────────────────────────────
       * Local wins for anything already present: the device the user is
       * holding has the most recent intent, and a pull must never resurrect a
       * title they just removed. Counters (streak, xp) take the MAXIMUM rather
       * than the remote value, so syncing can only ever move progress forward
       * — a stale server row cannot demote someone who kept using the app
       * offline.
       */
      applyRemoteSnapshot: (snapshot) =>
        set((state) => {
          const library = { ...state.library };
          const seenIds = new Set(state.seenIds);

          for (const row of snapshot.swipes) {
            seenIds.add(`${row.media_type}:${row.media_id}`);
          }

          for (const row of snapshot.watchlist) {
            const id = `remote-${row.media_type}-${row.media_id}`;
            const alreadyLocal = Object.values(library).some(
              (entry) =>
                entry.item.tmdb_id === row.media_id && entry.item.media_type === row.media_type,
            );
            if (alreadyLocal) continue;

            library[id] = {
              direction: 'superlike',
              at: Date.parse(row.added_at) || Date.now(),
              item: {
                id,
                tmdb_id: row.media_id,
                media_type: row.media_type,
                title: row.title,
                original_title: null,
                overview: null,
                poster_path: row.poster_path,
                backdrop_path: null,
                // Empty rather than guessed: an invented genre would poison
                // the taste profile, which is derived from these.
                genres: [],
                runtime_minutes: null,
                release_year: null,
                vote_average: row.rating,
                popularity: null,
                origin_country: [],
              },
            };
          }

          const reviews = { ...state.reviews };
          for (const row of snapshot.reviews) {
            // Flagged reviews are not restored: they are unpublished by
            // definition, and re-seeding one locally would show the author
            // content the server has already withheld.
            if (row.is_flagged) continue;
            const key = `${row.media_type}:${row.media_id}`;
            const existing = reviews[key] ?? [];
            if (existing.some((review) => review.id === row.id)) continue;
            reviews[key] = [
              {
                id: row.id,
                rating: row.rating,
                body: row.comment,
                at: Date.parse(row.created_at) || Date.now(),
              },
              ...existing,
            ];
          }

          const profile = snapshot.profile;
          const xp = Math.max(state.xp, profile?.xp ?? 0);

          /*
            Remote taste is adopted ONLY onto an empty local profile.

            The weights are a decayed running tally, not a set — there is no
            correct way to "merge" two of them, and picking max-per-genre would
            invent a profile neither device ever held. So: a reinstall or a new
            device (no local weights) inherits the cloud copy, and a device that
            has already learned something keeps what it learned and overwrites
            the server on its next swipe. Last writer wins, consistently.
          */
          const remoteTaste = readRemoteTaste(profile?.taste_profile);
          const adoptTaste =
            remoteTaste != null && Object.keys(state.genreWeights).length === 0;

          return {
            library,
            seenIds,
            reviews,
            xp,
            ...(adoptTaste
              ? {
                  genreWeights: remoteTaste.weights,
                  tasteSwipeCount: Math.max(state.tasteSwipeCount, remoteTaste.swipes),
                }
              : {}),
            streak: profile
              ? {
                  current: Math.max(state.streak.current, profile.streak_count),
                  longest: Math.max(state.streak.longest, profile.longest_streak),
                  lastDay: state.streak.lastDay ?? profile.last_swipe_date,
                }
              : state.streak,
          };
        }),

      hasSeenTutorial: false,
      completeTutorial: () => set({ hasSeenTutorial: true }),

      duoMatches: [],
      addDuoMatches: (matches) =>
        set((state) => {
          // Re-revealing the same title updates it in place instead of
          // stacking duplicates every time a session is re-run.
          const byId = new Map(state.duoMatches.map((m) => [m.media_item_id, m]));
          for (const match of matches) byId.set(match.media_item_id, match);
          return {
            duoMatches: [...byId.values()].sort((a, b) => b.at - a.at).slice(0, 60),
          };
        }),
      clearDuoMatches: () => set({ duoMatches: [] }),
      hasSeenDuoIntro: false,
      completeDuoIntro: () => set({ hasSeenDuoIntro: true }),

      seenIds: new Set<string>(),
      /**
       * Records what the deck has surfaced.
       *
       * The early return is OUTSIDE `set`, not inside it. Returning `{}` from
       * an updater still counts as a state change: zustand notifies every
       * subscriber, including persist's, which then re-serialises the whole
       * store for a write that changes nothing. This runs on every deck render,
       * so that was a full serialisation per render for no reason.
       */
      markSeen: (keys) => {
        const current = get().seenIds;
        let unseen: string[] | null = null;
        for (const key of keys) {
          if (current.has(key)) continue;
          (unseen ??= []).push(key);
        }
        if (!unseen) return;

        const next = new Set(current);
        for (const key of unseen) next.add(key);
        set({ seenIds: next });
      },
      clearSeen: () => set({ seenIds: new Set<string>() }),

      isPremium: DEV_PREMIUM,
      premiumCheckedAt: null,
      swipesRemaining: null,
      deckLocked: false,
      setPremium: (premium) =>
        set({
          // In dev the mock backend reports a free account, which would
          // immediately undo the bypass on the first swipe.
          isPremium: DEV_PREMIUM || premium,
          premiumCheckedAt: Date.now(),
          ...(DEV_PREMIUM || premium ? { deckLocked: false } : {}),
        }),
      setSwipesRemaining: (remaining) => set({ swipesRemaining: remaining }),
      setDeckLocked: (locked) => set({ deckLocked: locked }),

      reset: () =>
        set({
          session: null,
          profile: null,
          palette: DEFAULT_PALETTE,
          preferences: null,
          deckFilters: INITIAL_FILTERS,
          genreWeights: {},
          tasteSwipeCount: 0,
          personWeights: {},
          library: {},
          reviews: {},
          streak: { current: 0, longest: 0, lastDay: null },
          streakCelebration: null,
          xp: 0,
          levelCelebration: null,
          questDay: null,
          quests: [],
          seenIds: new Set<string>(),
          duoMatches: [],
          isPremium: DEV_PREMIUM,
          premiumCheckedAt: null,
          swipesRemaining: null,
          deckLocked: false,
        }),

      resetAll: () =>
        set({
          profile: null,
          palette: DEFAULT_PALETTE,
          preferences: null,
          deckFilters: INITIAL_FILTERS,
          genreWeights: {},
          tasteSwipeCount: 0,
          personWeights: {},
          library: {},
          reviews: {},
          streak: { current: 0, longest: 0, lastDay: null },
          streakCelebration: null,
          xp: 0,
          levelCelebration: null,
          questDay: null,
          quests: [],
          seenIds: new Set<string>(),
          duoMatches: [],
          hasSeenDuoIntro: false,
          hasSeenTutorial: false,
          isPremium: DEV_PREMIUM,
          premiumCheckedAt: null,
          swipesRemaining: null,
          deckLocked: false,
        }),
    }),
    {
      name: 'cineswipe-store',
      // v4 replaced Preferences.israeli with the top-level `region` axis.
      version: 4,
      /**
       * Older persisted state is dropped on purpose rather than partially
       * upgraded: pre-v4 preferences encode a country as a genre, which is the
       * exact modelling mistake this version removes. Re-running onboarding is
       * the correct outcome.
       *
       * Declaring this explicitly also silences zustand's "couldn't be migrated"
       * error — without a migrate function it discards state anyway, just
       * noisily and as if something had gone wrong.
       */
      migrate: () => undefined,
      // NOT createJSONStorage: that stringifies on every single `set`, and the
      // blob grows with the user's swipe history. See src/state/persist.ts for
      // the measurements and the durability guarantees.
      storage: coalescedStorage(zustandStorage),
      // Rehydration is triggered manually in the root layout AFTER the
      // encrypted MMKV instance exists (initStorage → persist.rehydrate).
      skipHydration: true,
      partialize: (state) => ({
        locale: state.locale,
        profile: state.profile,
        preferences: state.preferences,
        region: state.region,
        genreWeights: state.genreWeights,
        tasteSwipeCount: state.tasteSwipeCount,
        personWeights: state.personWeights,
        library: state.library,
        reviews: state.reviews,
        streak: state.streak,
        xp: state.xp,
        questDay: state.questDay,
        quests: state.quests,
        hasSeenTutorial: state.hasSeenTutorial,
        duoMatches: state.duoMatches,
        hasSeenDuoIntro: state.hasSeenDuoIntro,
        isPremium: state.isPremium,
        premiumCheckedAt: state.premiumCheckedAt,
      }),
    },
  ),
);

/** Whether the CURRENT native layout pass is right-to-left. */
export function isLayoutRTL(): boolean {
  return I18nManager.isRTL;
}

/**
 * Wipes persisted storage as well as in-memory state, so the next launch
 * behaves exactly like a fresh install (onboarding included).
 *
 * Drops the pending taste batch rather than flushing it: those swipes belong to
 * the account being erased, and applying them would write learned weights back
 * on top of the reset.
 */
export async function resetAppData(): Promise<void> {
  discardTasteQueue();
  useAppStore.getState().resetAll();
  // clearStorage → removeItem, which also cancels any queued persist write, so
  // nothing can land after the wipe. See src/state/persist.ts.
  await useAppStore.persist.clearStorage();
}

/** Throws away queued taste work — used when the data it belongs to is going away. */
export function discardTasteQueue(): void {
  tasteQueue = [];
  if (tasteTimer) {
    clearTimeout(tasteTimer);
    tasteTimer = null;
  }
}

/*
  Leaving the foreground is the last reliable moment before iOS may reclaim the
  process, so the batch is applied and the snapshot written out now rather than
  on a timer that may never fire. Order matters: the taste flush mutates state,
  so it has to run BEFORE the persist flush captures it.
*/
try {
  RNAppState.addEventListener('change', (status) => {
    if (status === 'active') return;
    flushTasteQueue();
    flushPersist();
  });
} catch {
  // Unavailable in some test environments; the timers still cover the normal case.
}

// ── Taste selectors ────────────────────────────────────────────────────

/**
 * Genres the user demonstrably likes, strongest first. Feeds straight into
 * TMDB's `with_genres`, which is why weak/negative signals are filtered out:
 * querying a genre the user dislikes would actively poison the deck.
 */
export function selectTopGenres(
  genreWeights: Record<string, number>,
  limit = 4,
): string[] {
  return Object.entries(genreWeights)
    .filter(([, weight]) => weight >= MIN_POSITIVE_WEIGHT)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([genre]) => genre);
}

/**
 * People strong enough to drive a query, strongest first.
 *
 * Filtered by role because the caller has to know WHICH TMDB parameter to send
 * it on — `with_cast` and `with_crew` are not interchangeable, and sending a
 * director id as `with_cast` quietly returns the films they merely acted in.
 */
export function selectTopPeople(
  personWeights: Record<string, PersonAffinity>,
  role: PersonRole,
  limit = 3,
): PersonAffinity[] {
  return Object.values(personWeights)
    .filter((person) => person.role === role && person.weight >= MIN_PERSON_WEIGHT)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

/** Every strong affinity regardless of role — drives the Profile display. */
export function selectTopCredits(
  personWeights: Record<string, PersonAffinity>,
  limit = 8,
): PersonAffinity[] {
  return Object.values(personWeights)
    .filter((person) => person.weight >= MIN_PERSON_WEIGHT)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

/** Sum of the user's person-weights for a specific set of credits. */
export function scoreCredits(
  personWeights: Record<string, PersonAffinity>,
  credits: TitleCreditsInput,
): number {
  let total = 0;
  if (credits.director) {
    total += personWeights[personKey('director', credits.director.id)]?.weight ?? 0;
  }
  for (const person of credits.cast) {
    total += personWeights[personKey('cast', person.id)]?.weight ?? 0;
  }
  return total;
}

/** Genres to actively avoid — used to down-rank incoming cards. */
export function selectDislikedGenres(genreWeights: Record<string, number>): string[] {
  return Object.entries(genreWeights)
    .filter(([, weight]) => weight <= -MIN_POSITIVE_WEIGHT)
    .map(([genre]) => genre);
}

/** Per-genre swipe tallies, derived from the library rather than the weights. */
export interface GenreStat {
  genre: string;
  liked: number;
  saved: number;
  seen: number;
  disliked: number;
  /** liked + saved — the "you're into this" number worth showing a user. */
  positive: number;
  total: number;
}

/**
 * Counts real swipes per genre.
 *
 * The For You explanations are built from THIS, not from `genreWeights`.
 * Weights are decayed, clamped and split by 1/√n, so they are a good ranking
 * signal but a meaningless thing to show someone — "because you like Drama 3.4"
 * explains nothing. A raw count ("you liked 5 Science Fiction titles") is a
 * claim the user can check against their own memory, which is the entire point
 * of showing a reason.
 */
export function selectGenreStats(
  library: Record<string, LibraryEntry>,
): Record<string, GenreStat> {
  const stats: Record<string, GenreStat> = {};
  for (const entry of Object.values(library)) {
    for (const genre of entry.item.genres) {
      const stat = (stats[genre] ??= {
        genre,
        liked: 0,
        saved: 0,
        seen: 0,
        disliked: 0,
        positive: 0,
        total: 0,
      });
      if (entry.direction === 'like') stat.liked += 1;
      else if (entry.direction === 'superlike') stat.saved += 1;
      else if (entry.direction === 'seen') stat.seen += 1;
      else stat.disliked += 1;
      stat.positive = stat.liked + stat.saved;
      stat.total += 1;
    }
  }
  return stats;
}

/** Ranked weights for display (Profile stats). */
export function selectRankedGenres(
  genreWeights: Record<string, number>,
): Array<{ genre: string; weight: number }> {
  return Object.entries(genreWeights)
    .sort((a, b) => b[1] - a[1])
    .map(([genre, weight]) => ({ genre, weight }));
}

// ── Library selectors ──────────────────────────────────────────────────
// Sorted newest-first so the most recent swipe appears at the top of a list.

function byDirection(
  library: Record<string, LibraryEntry>,
  direction: SwipeDirection,
): LibraryEntry[] {
  return Object.values(library)
    .filter((entry) => entry.direction === direction)
    .sort((a, b) => b.at - a.at);
}

/**
 * The "To Watch" tab — titles EXPLICITLY saved with a swipe up.
 *
 * ── This is strict, and it used to be a superset ───────────────────────────
 * The deck has two positive gestures: swipe RIGHT ("like") and swipe UP
 * ("save"). For a while this returned both, on the reasoning that a right
 * swipe means "yes, I'd watch this". The practical result was that the two
 * tabs looked like copies of each other: everything in Liked also appeared in
 * To Watch, and since right-swiping is the common gesture, the lists were
 * near-identical on screen.
 *
 * So the two are now disjoint by construction — a title is in exactly one of
 * them, decided by which gesture the user made. `selectWatchlist ∩ selectLiked
 * = ∅`. The trade is real and worth stating: a right swipe alone no longer
 * puts anything in To Watch. Saving is now a deliberate swipe UP.
 */
export function selectWatchlist(library: Record<string, LibraryEntry>): LibraryEntry[] {
  return byDirection(library, 'superlike');
}

/** Right-swipes only. Disjoint from `selectWatchlist` by construction. */
export function selectLiked(library: Record<string, LibraryEntry>): LibraryEntry[] {
  return byDirection(library, 'like');
}

/**
 * Swipe-up saves. Identical to `selectWatchlist` now that the tab is strict —
 * kept as a separate name because the Profile "saved" stat means the gesture,
 * not the tab, and the two should stay free to diverge again.
 */
export function selectSaved(library: Record<string, LibraryEntry>): LibraryEntry[] {
  return byDirection(library, 'superlike');
}

export function selectSeen(library: Record<string, LibraryEntry>): LibraryEntry[] {
  return byDirection(library, 'seen');
}
