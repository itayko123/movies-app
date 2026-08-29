/**
 * Poster → detail hero handoff.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Reanimated 4 REMOVED `sharedTransitionTag`; the v3 shared-element API was
 * experimental and did not survive the rewrite, and there is no drop-in
 * replacement in the current version. The community packages that fill the gap
 * (react-navigation-shared-element and friends) target React Navigation 5/6
 * screen internals and do not work with Expo Router v6 on RN 0.81.
 *
 * So the handoff is done by hand, which is really all a shared element ever
 * was: measure where the poster is on screen, tell the next screen, and have it
 * animate its hero from that rectangle to its final one.
 *
 * ── Why a module variable and not route params ─────────────────────────────
 * Four numbers in the URL would be visible in the address bar on web, would be
 * restored on a page refresh (animating from a rectangle that belongs to a
 * screen no longer on display), and would be deep-linkable — none of which is
 * wanted. This is transient presentation state that belongs to exactly one
 * navigation, so it lives for exactly one navigation and is CONSUMED on read.
 */

export interface HeroRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

let pending: HeroRect | null = null;

/** Records where the poster was, immediately before navigating. */
export function setHeroSource(rect: HeroRect): void {
  pending = rect;
}

/**
 * Reads and CLEARS the pending rect.
 *
 * Clearing is what stops a stale rectangle leaking into an unrelated later
 * navigation — open a title from a shelf, go back, then open another from the
 * tab bar, and without this the second screen would animate from the first
 * poster's position.
 */
export function takeHeroSource(): HeroRect | null {
  const rect = pending;
  pending = null;
  return rect;
}
