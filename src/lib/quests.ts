/**
 * Daily quests and the cinephile level curve.
 *
 * ── Why the quest set is derived, not stored ───────────────────────────────
 * The day's three quests are a pure function of the date. No randomness is
 * persisted and no server call is needed to find out what today's quests are,
 * which means they are identical on every device the user opens, they survive
 * a reinstall, and they cannot be re-rolled by force-quitting the app until a
 * kinder set appears.
 *
 * Only PROGRESS is state.
 *
 * ── The thresholds mirror supabase_schema.sql ──────────────────────────────
 * `cinephileLevel` here and `public.cinephile_level` there must agree, or the
 * badge the user sees locally will disagree with the one the server computes
 * after a sync. Both are listed in the same order for easy diffing; changing
 * one without the other is a bug.
 */

export type QuestKind =
  | 'swipe'
  | 'watchlist'
  | 'review'
  | 'high_rating'
  | 'region'
  | 'duo'
  | 'mood';

export interface DailyQuest {
  type: QuestKind;
  goal: number;
  progress: number;
  completed: boolean;
}

/** XP paid out when a quest completes. Matches c_reward_xp in the schema. */
export const QUEST_XP = 50;

interface QuestTemplate {
  type: QuestKind;
  goal: number;
  /**
   * Quests that cannot be finished in one sitting are demoralising rather than
   * motivating, so nothing here needs more than a few minutes of ordinary use.
   */
}

/**
 * The pool the day's three are drawn from.
 *
 * `swipe` is deliberately absent from the pool and always included separately:
 * it is the one quest every user can finish without going looking for a
 * feature, so a day whose three quests were all "write a review" would be a
 * day most people simply fail.
 */
const ALWAYS: QuestTemplate = { type: 'swipe', goal: 12 };

const POOL: QuestTemplate[] = [
  { type: 'watchlist', goal: 2 },
  { type: 'review', goal: 1 },
  { type: 'high_rating', goal: 1 },
  { type: 'region', goal: 2 },
  { type: 'duo', goal: 1 },
  { type: 'mood', goal: 2 },
];

/**
 * FNV-1a. Small, dependency-free, and — the only property that matters here —
 * stable: the same day key must produce the same quests on every device and
 * every platform, forever.
 */
function hashDay(dayKey: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < dayKey.length; i++) {
    hash ^= dayKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Today's three quests: one guaranteed swipe goal plus two from the pool. */
export function generateDailyQuests(dayKey: string): DailyQuest[] {
  const hash = hashDay(dayKey);

  // Walk the pool from a rotating offset with a coprime stride, so
  // consecutive days pick different pairs instead of drifting by one.
  const offset = hash % POOL.length;
  const stride = 1 + ((hash >>> 8) % (POOL.length - 1));

  const chosen: QuestTemplate[] = [ALWAYS];
  const taken = new Set<QuestKind>();
  for (let step = 0; chosen.length < 3 && step < POOL.length; step++) {
    const template = POOL[(offset + step * stride) % POOL.length]!;
    if (taken.has(template.type)) continue;
    taken.add(template.type);
    chosen.push(template);
  }

  return chosen.map((template) => ({
    type: template.type,
    goal: template.goal,
    progress: 0,
    completed: false,
  }));
}

// ── Cinephile levels ───────────────────────────────────────────────────────

/**
 * Minimum XP for each level, index 0 = level 1.
 *
 * Widening gaps: the first two levels should land inside a first session so
 * the mechanic is discovered by using the app rather than by reading about it,
 * while level 10 stays a genuine long haul.
 *
 * MUST match public.cinephile_level() in supabase_schema.sql.
 */
export const LEVEL_THRESHOLDS = [0, 100, 250, 500, 900, 1400, 2100, 3000, 4200, 6000] as const;

export const MAX_LEVEL = LEVEL_THRESHOLDS.length;

export function cinephileLevel(xp: number): number {
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_THRESHOLDS[i]!) level = i + 1;
  }
  return level;
}

export interface LevelProgress {
  level: number;
  /** XP into the current level. */
  current: number;
  /** XP the current level spans. `null` at max level. */
  span: number | null;
  /** 0–1 across the current level; 1 at max. */
  ratio: number;
  /** XP still needed for the next level, or null at max. */
  remaining: number | null;
}

export function levelProgress(xp: number): LevelProgress {
  const level = cinephileLevel(xp);
  const floor = LEVEL_THRESHOLDS[level - 1]!;

  if (level >= MAX_LEVEL) {
    return { level, current: xp - floor, span: null, ratio: 1, remaining: null };
  }

  const ceiling = LEVEL_THRESHOLDS[level]!;
  const span = ceiling - floor;
  const current = xp - floor;
  return {
    level,
    current,
    span,
    ratio: span > 0 ? Math.min(Math.max(current / span, 0), 1) : 0,
    remaining: ceiling - xp,
  };
}

/** i18n key for a level's title, e.g. `level.name.5`. */
export function levelNameKey(level: number): string {
  return `level.name.${Math.min(Math.max(level, 1), MAX_LEVEL)}`;
}
