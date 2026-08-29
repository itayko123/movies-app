import { fetchTitleCredits, type MediaType } from '@/lib/tmdb';
import { useAppStore } from '@/state/store';
import type { SwipeDirection } from '@/types/media';

/**
 * Background learning pass: turns a swipe into authorship signal.
 *
 * ── Why this is separate from `recordSwipe` ─────────────────────────────────
 * Genres arrive free with every list response, so folding them in is pure
 * synchronous state. Credits do not: they need a second TMDB request per
 * title. Doing that inside the swipe handler would put a network round-trip
 * directly in the path of a 60fps gesture, and a slow response would stall the
 * card under the user's finger.
 *
 * So the swipe commits immediately on genre signal alone, and this runs
 * afterwards, fire-and-forget. The person vector converges a few hundred
 * milliseconds behind the genre vector, which no user can perceive and no
 * subsequent query depends on within that window.
 *
 * Every failure path is silent by design. Losing one title's credits costs a
 * fraction of a recommendation; surfacing a network error for it would be
 * noise about a feature the user never asked to run.
 */

/**
 * Titles whose credits have already been requested this session.
 *
 * Prevents a re-swipe (undo, or the same title reappearing after a filter
 * change) from double-counting a person, which would inflate the "you liked N
 * films with X" claim above the number of films the user actually swiped.
 */
const learned = new Set<string>();

/**
 * Directions worth spending a request on.
 *
 * A dislike carries real signal for genres — it is cheap, already local, and
 * three quarters of swipes are dislikes. Spending a TMDB round-trip on each of
 * them to learn "you are mildly negative on this third-billed actor" is not
 * worth the request budget, and the resulting weights are too diffuse to steer
 * anything. Only positive swipes teach the person vector.
 */
const LEARNING_DIRECTIONS: ReadonlySet<SwipeDirection> = new Set<SwipeDirection>([
  'like',
  'superlike',
  'seen',
]);

export interface LearnableTitle {
  tmdb_id: number;
  media_type: MediaType;
}

/**
 * Fetches a title's director + top cast and folds them into the taste vector.
 * Resolves once the state write has happened (tests await it; callers do not).
 */
export async function learnTitleCredits(
  item: LearnableTitle,
  direction: SwipeDirection,
): Promise<void> {
  if (!LEARNING_DIRECTIONS.has(direction)) return;

  const key = `${item.media_type}:${item.tmdb_id}`;
  if (learned.has(key)) return;
  learned.add(key);

  try {
    const credits = await fetchTitleCredits(item.tmdb_id, item.media_type);
    if (!credits.director && credits.cast.length === 0) return;
    useAppStore.getState().learnCredits(credits, direction);
  } catch {
    // Allow a retry on a later encounter rather than permanently blacklisting
    // the title over one transient failure.
    learned.delete(key);
  }
}

/** Test/reset seam — clears the session-level dedupe set. */
export function resetCreditLearning(): void {
  learned.clear();
}
