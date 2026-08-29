import { useCallback, useRef, useState } from 'react';
import { Platform, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useFocusEffect } from 'expo-router';
import Animated, {
  runOnJS,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';

/**
 * A paged carousel that advances itself, on the UI thread.
 *
 * ── Why not a JS interval ──────────────────────────────────────────────────
 * The obvious build is `setInterval` + `scrollToIndex`. The timer is cheap, but
 * the page dots need the scroll position every frame, and an `onScroll` prop is
 * a 60fps hop onto the JS thread — on a screen also decoding remote artwork,
 * that is where dropped frames come from. Here the position lives in a shared
 * value, dots read it via `useAnimatedStyle`, and advances are issued by
 * `scrollTo()` from a worklet. Zero JS per frame, zero JS per advance.
 *
 * ── Seamless looping: a trailing clone ─────────────────────────────────────
 * Neither FlatList nor a native pager loops, and rewinding to the start looks
 * cheap. So the data carries one clone of the first item at the END:
 *
 *     [ item1 … itemN , clone(item1) ]
 *
 * Advancing onto the clone — pixel-identical to item1 — triggers a
 * NON-animated jump back to item1. Nothing rewinds and nothing is seen.
 *
 * A LEADING clone was tried first, with `initialScrollIndex` resting on index
 * 1. It failed under RTL in a way worth recording: FlatList's own index
 * bookkeeping said index 1 and it rendered items 1–2, while the underlying
 * scroller never left offset 0 — which in a right-origin layout is the start.
 * The rendered cards sat off-screen at x = -339 and the hero was an empty box.
 * Resting at the list's NATURAL origin removes the whole class of bug: there is
 * no initial scroll to desync from. The cost is that dragging backwards off the
 * first card stops rather than wrapping, which is ordinary carousel behaviour
 * and invisible to auto-advance, since that only ever moves forward.
 *
 * ── RTL, which is the dangerous part ───────────────────────────────────────
 * `scrollTo` takes a raw x offset, and iOS, Android and the browser disagree
 * about where `contentOffset.x === 0` sits under RTL. So this hook never
 * computes an absolute offset and never asks which platform it is on. Instead
 * the direction of "one page forward" is MEASURED, from real motion:
 *
 *   1. The very first advance is issued through `scrollToIndex`, whose index
 *      math is already correct on every platform. One JS call, once, ever.
 *   2. While that scroll runs, successive offsets are compared. Their sign IS
 *      the answer — no origin, no platform check, no arithmetic on a value we
 *      only assumed.
 *   3. Once it settles, the origin is back-derived from a measured position
 *      (`offset − dir × stride`), and every later advance is a worklet
 *      `scrollTo(measuredOffset + dir × stride)`.
 *   4. Until the sign is known, auto-advance does not free-run. Scrolling the
 *      wrong way is far worse than not scrolling.
 */

/** Minimal shape needed off the list instance. */
interface ScrollableList {
  scrollToIndex?: (options: { index: number; animated: boolean }) => void;
}

/** A carousel needs at least this many real items before looping is worth it. */
const MIN_LOOP_ITEMS = 2;

/** Movement smaller than this is noise, not a page. */
const SIGN_EPSILON = 2;

/** Appends a clone of the first item so the loop has somewhere to land. */
export function padForLoop<T>(items: T[]): T[] {
  if (items.length < MIN_LOOP_ITEMS) return items;
  return [...items, items[0]!];
}

export interface AutoCarouselOptions {
  /** Number of REAL items, before padding. */
  count: number;
  /** Card width + gap, in px. One page. */
  stride: number;
  /** How long a card sits still before the next advance. */
  dwellMs?: number;
}

export function useAutoCarousel({ count, stride, dwellMs = 5000 }: AutoCarouselOptions) {
  const reduceMotion = useReducedMotion();
  /**
   * Reanimated is inert under react-native-web in this project, and
   * reduced-motion users have opted out. In both cases the carousel must stay
   * VISIBLE and hand-scrollable — it simply does not advance itself. Content
   * visibility never depends on an animation running.
   */
  const inert = Platform.OS === 'web' || reduceMotion;
  const loops = count >= MIN_LOOP_ITEMS;

  const aref = useAnimatedRef<Animated.FlatList<unknown>>();
  const listRef = useRef<ScrollableList | null>(null);

  const offset = useSharedValue(0);
  const lastOffset = useSharedValue(0);
  /** +1 or -1 once measured; 0 means "not yet known". */
  const dir = useSharedValue(0);
  /** Measured offset of item 0. NaN until calibration settles. */
  const origin = useSharedValue(Number.NaN);
  const dragging = useSharedValue(false);
  const sinceAdvance = useSharedValue(0);
  /** True between issuing the calibration scroll and it settling. */
  const calibrating = useSharedValue(false);
  /** Fractional page index (0 … count-1). Drives the dots. */
  const progress = useSharedValue(0);

  /** Dot index for inert platforms, where animated styles never apply. */
  const [inertIndex, setInertIndex] = useState(0);

  /**
   * The one and only JS-side scroll: the calibration move that lets us measure
   * which numeric direction is forward.
   */
  const calibrateAdvance = useCallback(() => {
    listRef.current?.scrollToIndex?.({ index: 1, animated: true });
  }, []);

  const pageOf = useCallback(() => {
    'worklet';
    return (offset.value - origin.value) / (dir.value * stride);
  }, [dir, offset, origin, stride]);

  /**
   * The invisible half of the loop: if we settled on the trailing clone, jump
   * to its real twin without animating. They are identical, so nothing shows.
   */
  const wrapIfOnClone = useCallback(() => {
    'worklet';
    if (!loops || dir.value === 0 || Number.isNaN(origin.value)) return;
    if (Math.round(pageOf()) < count) return;
    scrollTo(aref, origin.value, 0, false);
    offset.value = origin.value;
    lastOffset.value = origin.value;
    progress.value = 0;
  }, [aref, count, dir, lastOffset, loops, offset, origin, pageOf, progress]);

  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      const x = event.contentOffset.x;
      offset.value = x;

      // Measure the sign from real motion, once.
      if (dir.value === 0) {
        const delta = x - lastOffset.value;
        if (Math.abs(delta) > SIGN_EPSILON) dir.value = delta > 0 ? 1 : -1;
      }

      if (dir.value !== 0 && !Number.isNaN(origin.value)) {
        progress.value = pageOf();
      }
      lastOffset.value = x;
    },
    onBeginDrag: () => {
      // A thumb on the card resets the dwell, so the carousel never yanks
      // itself out from under someone who is reading it.
      dragging.value = true;
      sinceAdvance.value = 0;
    },
    onEndDrag: () => {
      dragging.value = false;
    },
    onMomentumEnd: () => {
      dragging.value = false;
      sinceAdvance.value = 0;

      if (calibrating.value) {
        calibrating.value = false;
        // We are on index 1 by construction, so index 0 is one page back —
        // back-derived from a measured position, never from an assumed origin.
        if (dir.value !== 0) {
          origin.value = offset.value - dir.value * stride;
          progress.value = 1;
        }
        return;
      }

      wrapIfOnClone();
    },
  });

  /**
   * The clock. A frame callback rather than a timer: it lives on the UI thread
   * with everything else here, and `setActive` gives exact control over when it
   * stops — which matters, since a carousel that keeps paging on a backgrounded
   * tab is just battery drain.
   */
  const frame = useFrameCallback(({ timeSincePreviousFrame }) => {
    'worklet';
    if (dragging.value || calibrating.value) return;
    sinceAdvance.value += timeSincePreviousFrame ?? 16;
    if (sinceAdvance.value < dwellMs) return;
    sinceAdvance.value = 0;

    if (dir.value === 0 || Number.isNaN(origin.value)) {
      // First move of this carousel's life: hand it to FlatList so we can watch
      // which way it goes.
      calibrating.value = true;
      runOnJS(calibrateAdvance)();
      return;
    }

    scrollTo(aref, offset.value + dir.value * stride, 0, true);
  }, false);

  useFocusEffect(
    useCallback(() => {
      if (inert || !loops) return;
      frame.setActive(true);
      return () => frame.setActive(false);
    }, [frame, inert, loops]),
  );

  /**
   * Both refs on one element: the animated ref is what `scrollTo` worklets
   * need, the plain one carries FlatList's imperative methods. Reanimated's
   * animated ref is callable, which is what makes the merge possible.
   */
  const setListRef = useCallback(
    (node: ScrollableList | null) => {
      listRef.current = node;
      (aref as unknown as (n: ScrollableList | null) => void)(node);
    },
    [aref],
  );

  /**
   * Dot tracking for inert platforms. Once per settle, never per frame, so it
   * costs nothing — and it never runs where the animated path works.
   */
  const onInertMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!inert) return;
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const span = contentSize.width - layoutMeasurement.width;
      // Same measured-not-assumed idea as the worklet path, in miniature: try
      // both origins and keep whichever lands inside the real page range.
      const fromStart = Math.round(Math.abs(contentOffset.x) / stride);
      const fromEnd = Math.round((span - Math.abs(contentOffset.x)) / stride);
      const index = fromStart < count ? fromStart : fromEnd;
      if (index >= 0 && index < count) setInertIndex(index);
    },
    [count, inert, stride],
  );

  const getItemLayout = useCallback(
    (_data: ArrayLike<unknown> | null | undefined, index: number) => ({
      length: stride,
      offset: stride * index,
      index,
    }),
    [stride],
  );

  return {
    /** Attach to the Animated.FlatList's `ref` — wires both refs at once. */
    setListRef,
    scrollHandler,
    getItemLayout,
    onInertMomentumEnd,
    /** Fractional page — for animated dots. */
    progress,
    /** Whole page — for dots where animated styles cannot run. */
    inertIndex,
    inert,
    loops,
  };
}
