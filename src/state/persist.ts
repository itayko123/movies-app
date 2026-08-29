import { AppState } from 'react-native';
import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';

/**
 * Persistence that does NOT run on the swipe frame.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 * zustand's persist middleware serialises the whole partialized store on EVERY
 * `set`. That is fine for a settings screen and ruinous for a deck: a swipe
 * fires two or three `set` calls, and each one re-serialises a blob that grows
 * with the user's entire swipe history, because `library` holds a full
 * MediaItemRow — title, overview, genres — per swiped title.
 *
 * Measured on desktop V8 (Hermes on a phone is several times slower):
 *
 *     library    blob     JSON.stringify
 *        50     38 KB        0.17 ms
 *       200    114 KB        0.43 ms
 *       500    267 KB        2.00 ms
 *      1000    523 KB        3.10 ms
 *
 * So the app gets progressively less responsive the more it is used, which is
 * exactly the shape of "it still feels laggy" after the obvious stalls have
 * been removed. Nothing about the swipe itself got slower — the store got
 * bigger.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Keep only the newest snapshot and serialise it once per quiet moment instead
 * of once per mutation. A burst of ten rapid swipes costs ONE stringify rather
 * than twenty-plus, and the cost lands between gestures rather than inside one.
 *
 * ── Durability ─────────────────────────────────────────────────────────────
 * A debounce is a promise to write later, so the window has to be closed at
 * both ends or a swipe made just before the user leaves is lost:
 *
 *   • the window is short (FLUSH_MS);
 *   • leaving the foreground flushes immediately — that is the moment iOS is
 *     most likely to reclaim the process;
 *   • `removeItem` (sign-out, delete-account, factory reset) cancels anything
 *     pending, so a queued write can never resurrect data the user just erased.
 *
 * `flushNow()` is exported for callers that need the guarantee synchronously.
 */

/** Quiet period before the pending snapshot is written. */
const FLUSH_MS = 400;

interface Pending {
  name: string;
  value: unknown;
}

let pending: Pending | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let backend: StateStorage | null = null;

function cancel(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Serialises and writes the newest snapshot, if there is one. */
export function flushNow(): void {
  cancel();
  const job = pending;
  pending = null;
  if (!job || !backend) return;
  try {
    void Promise.resolve(backend.setItem(job.name, JSON.stringify(job.value))).catch(
      (error) => {
        if (__DEV__) console.warn('[persist] write failed:', error);
      },
    );
  } catch (error) {
    // Serialisation itself can throw (a cycle, a BigInt). Losing one write is
    // survivable; taking the app down over it is not.
    if (__DEV__) console.warn('[persist] serialise failed:', error);
  }
}

// Leaving the foreground is the last reliable moment before the OS may kill
// the process, so anything pending goes out now.
try {
  AppState.addEventListener('change', (status) => {
    if (status !== 'active') flushNow();
  });
} catch {
  // AppState is unavailable in some test/SSR environments; the timer still runs.
}

/**
 * Wraps a raw key/value backend in the coalescing layer.
 *
 * Generic over the persisted slice so it drops into `persist({ storage })` in
 * place of `createJSONStorage`, which is what it replaces — that helper is the
 * thing that stringifies eagerly.
 */
export function coalescedStorage<S>(base: StateStorage): PersistStorage<S> {
  backend = base;
  return {
    getItem: async (name) => {
      const raw = await base.getItem(name);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as StorageValue<S>;
      } catch (error) {
        // Corrupt payload: report null so persist falls back to initial state
        // rather than throwing during hydration and blanking the app.
        if (__DEV__) console.warn('[persist] unreadable payload, ignoring:', error);
        return null;
      }
    },
    setItem: (name, value) => {
      pending = { name, value };
      if (!timer) timer = setTimeout(flushNow, FLUSH_MS);
    },
    removeItem: (name) => {
      // Drop the queued write first — otherwise it lands after the delete and
      // restores what the user asked to remove.
      pending = null;
      cancel();
      return base.removeItem(name);
    },
  };
}
