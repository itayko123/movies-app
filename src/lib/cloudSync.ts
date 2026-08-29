/**
 * Cloud sync: mirrors local state into Supabase, and pulls it back on a new
 * device.
 *
 * ── Local-first, not cloud-first ───────────────────────────────────────────
 * Every write lands in the Zustand store FIRST and is queued for the cloud
 * afterwards. Nothing in the UI ever waits on a round trip: a swipe is a
 * gesture, and putting a network call in front of it would make the deck feel
 * broken on a train. The cloud is a backup and a second device, not the source
 * of truth for a session in progress.
 *
 * That means writes must survive being offline, so failed operations stay in a
 * persisted queue and are retried on the next flush.
 *
 * ── Why this module does not import the store ──────────────────────────────
 * `store.ts` calls into here to enqueue, so importing the store back would
 * close a cycle (store -> cloudSync -> store) that Metro resolves by handing
 * one of them a half-initialised module. Instead the session is pushed in via
 * `setCloudSession`, and `pullRemote()` RETURNS data for the caller to apply.
 * The dependency arrow points one way, always.
 */
import type { Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { zustandStorage } from '@/lib/storage';
import type { MediaItemRow, SwipeDirection } from '@/types/media';

const QUEUE_KEY = 'cineswipe-cloud-queue';
/**
 * Cap on queued operations.
 *
 * A user offline for a week could otherwise accumulate an unbounded queue that
 * takes minutes to drain and may never succeed. Oldest operations are dropped
 * first: the newest state is the state worth preserving, and swipes are
 * upserts, so losing an old one costs a taste signal rather than corrupting
 * anything.
 */
const MAX_QUEUE = 500;

export type CloudOp =
  | { kind: 'swipe'; media_id: number; media_type: 'movie' | 'tv'; direction: SwipeDirection; at: number }
  | {
      kind: 'watchlist:add';
      media_id: number;
      media_type: 'movie' | 'tv';
      title: string;
      poster_path: string | null;
      rating: number | null;
      at: number;
    }
  | { kind: 'watchlist:remove'; media_id: number; media_type: 'movie' | 'tv'; at: number }
  | {
      kind: 'review:add';
      media_id: number;
      media_type: 'movie' | 'tv';
      rating: number;
      comment: string;
      at: number;
    }
  | { kind: 'streak'; local_date: string; at: number }
  | { kind: 'quest'; local_date: string; quest_type: string; amount: number; at: number }
  /**
   * The learned genre tally, mirrored to `profiles.taste_profile`.
   *
   * Sends the WHOLE map rather than a per-swipe delta. The weights are derived
   * from decay-and-renormalise arithmetic over the full history (see
   * recordSwipe), so replaying deltas out of order — which an offline queue
   * explicitly permits — would converge on a different profile than the device
   * actually holds. Last write wins, and the last write is always the truth.
   */
  | { kind: 'taste'; weights: Record<string, number>; swipes: number; at: number };

let session: Session | null = null;
let queue: CloudOp[] = [];
let loaded = false;
let flushing = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The dev mock session carries a fake bearer token; sending it to a real
 * Supabase project produces a 401 on every request. Recognising it here is what
 * stops the queue from spinning against an endpoint that can never accept it.
 */
function isMockSession(candidate: Session | null): boolean {
  return candidate?.access_token === 'mock-access-token';
}

/** True when there is a real backend AND a real signed-in user. */
export function cloudReady(): boolean {
  return isSupabaseConfigured && session != null && !isMockSession(session);
}

export function setCloudSession(next: Session | null): void {
  session = next;
  if (cloudReady()) scheduleFlush();
}

export function currentUserId(): string | null {
  return cloudReady() ? (session?.user.id ?? null) : null;
}

// ── Queue persistence ──────────────────────────────────────────────────────

async function loadQueue(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await zustandStorage.getItem(QUEUE_KEY);
    if (raw) queue = JSON.parse(raw) as CloudOp[];
  } catch {
    // A corrupt queue is not worth crashing over — the local store is intact
    // and a full pull will reconcile on the next sign-in.
    queue = [];
  }
}

async function saveQueue(): Promise<void> {
  try {
    await zustandStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Non-fatal: the queue stays in memory for this session.
  }
}

/**
 * Queues one operation.
 *
 * Safe to call whether or not a backend exists: with no cloud configured this
 * is a no-op, so callers do not have to branch. Nothing is queued in that case
 * either, because a queue that can never drain is just a slow memory leak.
 */
export function enqueue(op: CloudOp): void {
  if (!isSupabaseConfigured) return;

  void (async () => {
    await loadQueue();

    // Collapse supersedable operations: re-swiping a title or re-saving it
    // replaces the earlier entry rather than stacking, so a user flicking back
    // and forth does not generate fifty writes for one final state.
    if (op.kind === 'swipe' || op.kind === 'watchlist:add' || op.kind === 'watchlist:remove') {
      const isSameTarget = (other: CloudOp) =>
        (other.kind === 'swipe' || other.kind === 'watchlist:add' || other.kind === 'watchlist:remove') &&
        other.media_id === op.media_id &&
        other.media_type === op.media_type &&
        // A swipe and a watchlist op are different writes to different tables;
        // only collapse like with like.
        other.kind.split(':')[0] === op.kind.split(':')[0];
      queue = queue.filter((other) => !isSameTarget(other));
    }

    // A taste op carries the COMPLETE map, so any earlier one is dead weight —
    // keeping them would mean a swipe burst queues one full-profile write per
    // swipe, all but the last describing a superseded state.
    if (op.kind === 'taste') queue = queue.filter((other) => other.kind !== 'taste');

    queue.push(op);
    if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
    await saveQueue();
    scheduleFlush();
  })();
}

function scheduleFlush(): void {
  if (!cloudReady() || flushTimer) return;
  // Coalesce a burst of swipes into one drain.
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 1200);
}

// ── Applying one operation ─────────────────────────────────────────────────

async function apply(op: CloudOp, userId: string): Promise<void> {
  switch (op.kind) {
    case 'swipe': {
      const { error } = await supabase
        .from('swipes')
        .upsert(
          {
            user_id: userId,
            media_id: op.media_id,
            media_type: op.media_type,
            direction: op.direction,
          },
          { onConflict: 'user_id,media_id,media_type' },
        );
      if (error) throw error;
      return;
    }

    case 'watchlist:add': {
      const { error } = await supabase
        .from('watchlist')
        .upsert(
          {
            user_id: userId,
            media_id: op.media_id,
            media_type: op.media_type,
            title: op.title,
            poster_path: op.poster_path,
            rating: op.rating,
          },
          { onConflict: 'user_id,media_id,media_type' },
        );
      if (error) throw error;
      return;
    }

    case 'watchlist:remove': {
      const { error } = await supabase
        .from('watchlist')
        .delete()
        .eq('user_id', userId)
        .eq('media_id', op.media_id)
        .eq('media_type', op.media_type);
      if (error) throw error;
      return;
    }

    case 'review:add': {
      // is_flagged is deliberately NOT sent: a database trigger recomputes it
      // from the comment on every insert, so anything the client claimed here
      // would be overwritten anyway. See reviews_flag_profanity in
      // supabase_schema.sql.
      const { error } = await supabase.from('reviews').insert({
        user_id: userId,
        media_id: op.media_id,
        media_type: op.media_type,
        rating: op.rating,
        comment: op.comment,
      });
      if (error) throw error;
      return;
    }

    case 'streak': {
      const { error } = await supabase.rpc('touch_streak', { p_local_date: op.local_date });
      if (error) throw error;
      return;
    }

    case 'quest': {
      const { error } = await supabase.rpc('advance_quest', {
        p_date: op.local_date,
        p_quest_type: op.quest_type,
        p_amount: op.amount,
      });
      if (error) throw error;
      return;
    }

    case 'taste': {
      // UPDATE, not upsert: the row is created by the handle_new_user trigger,
      // and an upsert here would need to supply every not-null column just to
      // write one jsonb field.
      const { error } = await supabase
        .from('profiles')
        .update({
          taste_profile: { liked_genres: op.weights, swipes: op.swipes, updated_at: op.at },
        })
        .eq('id', userId);
      if (error) throw error;
      return;
    }
  }
}

/**
 * Drains the queue.
 *
 * Stops at the first transport failure and keeps the remainder for later —
 * order matters (an add followed by a remove must not be applied in reverse).
 * A failure the server has already judged (4xx that is not auth) drops the
 * operation instead, because retrying it forever would wedge the whole queue
 * behind one permanently invalid row.
 */
export async function flush(): Promise<{ sent: number; remaining: number }> {
  if (!cloudReady() || flushing) return { sent: 0, remaining: queue.length };
  flushing = true;
  await loadQueue();

  const userId = session!.user.id;
  let sent = 0;

  try {
    while (queue.length > 0) {
      const op = queue[0]!;
      try {
        await apply(op, userId);
        queue.shift();
        sent++;
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        // 23xxx = integrity violation, 22xxx = data exception: the row itself
        // is the problem and no number of retries will change that.
        const permanent = /^2[23]/.test(code);
        if (permanent) {
          if (__DEV__) console.warn('[cloudSync] dropping unprocessable op', op.kind, code);
          queue.shift();
          continue;
        }
        break;
      }
    }
  } finally {
    await saveQueue();
    flushing = false;
  }

  return { sent, remaining: queue.length };
}

export async function pendingCount(): Promise<number> {
  await loadQueue();
  return queue.length;
}

// ── Pull ───────────────────────────────────────────────────────────────────

export interface RemoteSnapshot {
  swipes: Array<{ media_id: number; media_type: 'movie' | 'tv'; direction: SwipeDirection; created_at: string }>;
  watchlist: Array<{
    media_id: number;
    media_type: 'movie' | 'tv';
    title: string;
    poster_path: string | null;
    rating: number | null;
    added_at: string;
  }>;
  reviews: Array<{
    id: string;
    media_id: number;
    media_type: 'movie' | 'tv';
    rating: number;
    comment: string;
    is_flagged: boolean;
    created_at: string;
  }>;
  profile: {
    streak_count: number;
    longest_streak: number;
    last_swipe_date: string | null;
    cinephile_level: number;
    xp: number;
    /** `{ liked_genres, swipes, updated_at }`, or `{}` before the first sync. */
    taste_profile: unknown;
  } | null;
}

/**
 * Reads this user's rows back.
 *
 * Returns null rather than throwing when the cloud is unavailable: a failed
 * pull means "carry on with what is on the device", which is a normal state,
 * not an error the UI needs to surface.
 */
export async function pullRemote(): Promise<RemoteSnapshot | null> {
  if (!cloudReady()) return null;
  const userId = session!.user.id;

  try {
    const [swipes, watchlist, reviews, profile] = await Promise.all([
      supabase.from('swipes').select('media_id,media_type,direction,created_at').eq('user_id', userId),
      supabase
        .from('watchlist')
        .select('media_id,media_type,title,poster_path,rating,added_at')
        .eq('user_id', userId),
      supabase
        .from('reviews')
        .select('id,media_id,media_type,rating,comment,is_flagged,created_at')
        .eq('user_id', userId),
      supabase
        .from('profiles')
        .select('streak_count,longest_streak,last_swipe_date,cinephile_level,xp,taste_profile')
        .eq('id', userId)
        .maybeSingle(),
    ]);

    if (swipes.error || watchlist.error || reviews.error) return null;

    return {
      swipes: (swipes.data ?? []) as RemoteSnapshot['swipes'],
      watchlist: (watchlist.data ?? []) as RemoteSnapshot['watchlist'],
      reviews: (reviews.data ?? []) as RemoteSnapshot['reviews'],
      profile: (profile.data ?? null) as RemoteSnapshot['profile'],
    };
  } catch {
    return null;
  }
}

// ── Convenience emitters used by the store ─────────────────────────────────

/**
 * One swipe produces up to two writes: the swipe itself, and the watchlist row
 * that a superlike implies. Un-superliking has to DELETE that row, or a title
 * removed on one device would reappear from the cloud on the next.
 */
export function syncSwipe(item: MediaItemRow, direction: SwipeDirection): void {
  const at = Date.now();
  enqueue({
    kind: 'swipe',
    media_id: item.tmdb_id,
    media_type: item.media_type,
    direction,
    at,
  });

  if (direction === 'superlike') {
    enqueue({
      kind: 'watchlist:add',
      media_id: item.tmdb_id,
      media_type: item.media_type,
      title: item.title,
      poster_path: item.poster_path,
      rating: item.vote_average,
      at,
    });
  } else {
    enqueue({ kind: 'watchlist:remove', media_id: item.tmdb_id, media_type: item.media_type, at });
  }
}

export function syncReview(
  mediaKey: string,
  rating: number,
  comment: string,
): void {
  const [type, id] = mediaKey.split(':');
  const media_id = Number(id);
  if (!Number.isFinite(media_id) || (type !== 'movie' && type !== 'tv')) return;
  enqueue({ kind: 'review:add', media_id, media_type: type, rating, comment, at: Date.now() });
}

export function syncStreak(localDate: string): void {
  enqueue({ kind: 'streak', local_date: localDate, at: Date.now() });
}

export function syncQuest(localDate: string, questType: string, amount = 1): void {
  enqueue({ kind: 'quest', local_date: localDate, quest_type: questType, amount, at: Date.now() });
}

/**
 * Mirrors the learned genre tally up.
 *
 * Called on every liked/superliked swipe. That is a lot of calls, which is
 * exactly why `enqueue` collapses consecutive taste ops — a burst of twenty
 * swipes leaves one queued write holding the final map, not twenty writes each
 * describing a state that is already stale.
 */
export function syncTaste(weights: Record<string, number>, swipes: number): void {
  enqueue({ kind: 'taste', weights, swipes, at: Date.now() });
}

/**
 * Irreversibly deletes the signed-in user's account and all their rows.
 *
 * Throws on failure so the caller can tell the user it did NOT happen — a
 * silently-swallowed deletion is the worst possible outcome here, because the
 * user walks away believing their data is gone.
 *
 * The pending write queue is dropped FIRST. Otherwise a queued swipe drains
 * after the account is gone, fails against a missing profile, and retries
 * forever against a user id that no longer exists.
 */
export async function deleteAccount(): Promise<void> {
  if (!cloudReady()) throw new Error('not_authenticated');

  queue = [];
  loaded = true;
  await saveQueue();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const { error } = await supabase.rpc('delete_own_account');
  if (error) throw new Error(error.message);
}
