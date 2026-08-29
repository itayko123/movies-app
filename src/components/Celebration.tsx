import { useEffect, useRef, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

/**
 * Celebration animation primitives.
 *
 * ── Why this is not Lottie ─────────────────────────────────────────────────
 * `lottie-react-native` is a native module: it needs a prebuild/dev-client, so
 * it renders NOTHING in Expo Go, and its web support is a separate renderer
 * package. Those are the two environments this app is actually exercised in, so
 * a Lottie celebration would be invisible in exactly the places anyone would
 * look at it — and it would add a dependency plus third-party JSON assets for
 * an effect that is a few dozen lines of geometry.
 *
 * ── Why not Reanimated either ──────────────────────────────────────────────
 * Reanimated animated styles are inert under react-native-web in this project
 * (the long-standing constraint behind the swipe-commit timer and the
 * `entering`-animation rule). A Reanimated burst would animate on device and
 * sit frozen on web.
 *
 * So the progress value is driven through plain React state by a
 * requestAnimationFrame ticker, and every transform is computed from it. That
 * runs identically on iOS, Android and web. It costs a re-render per frame,
 * which is acceptable precisely here: a celebration is a short, one-shot,
 * full-screen moment where nothing else is competing for the main thread.
 */

/**
 * Drives 0 → 1 over `duration`, then holds. `active: false` resets to 0.
 *
 * ── The completion guarantee ───────────────────────────────────────────────
 * `requestAnimationFrame` is NOT reliable. Browsers suspend it in background
 * tabs and when a page is not compositing, and the OS can throttle it under
 * load. Caught live: with the browser pane hidden, rAF never fired once across
 * 193 samples and `progress` stayed pinned at 0 — which, since the overlay's
 * scale is derived from it, would have rendered the entire "It's a Match"
 * screen at scale 0. Invisible. Including the dismiss button.
 *
 * So a timer backstop force-completes the animation. If rAF is healthy the
 * value is already 1 by then and the extra set is a no-op; if rAF never ran,
 * the user still lands on a fully readable overlay. The animation is allowed to
 * be skipped — it is never allowed to swallow the content.
 *
 * This is the same rule as the `entering`-animation ban elsewhere in the app:
 * never let content visibility depend on an animation completing.
 */
export function useCelebrationProgress(active: boolean, duration = 1500): number {
  const [progress, setProgress] = useState(0);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      setProgress(0);
      return;
    }
    const start = Date.now();
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - start;
      const next = Math.min(elapsed / duration, 1);
      setProgress(next);
      if (next < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);

    // Backstop: guarantees the end state regardless of rAF's behaviour.
    const settle = setTimeout(() => {
      if (!cancelled) setProgress(1);
    }, duration + 250);

    return () => {
      cancelled = true;
      clearTimeout(settle);
      if (frame.current != null) cancelAnimationFrame(frame.current);
    };
  }, [active, duration]);

  return progress;
}

/**
 * Maps eased progress onto a scale that is ALREADY LEGIBLE at progress 0.
 *
 * Content must never animate up from scale 0 — see the note above. A pop from
 * 0.9 reads as a pop, and its worst case (no animation at all) is a element
 * that is 10% small for one frame rather than one that is not there.
 */
export function popScale(eased: number, from = 0.9): number {
  return from + (1 - from) * eased;
}

/** Decelerating ease — fast out of the gate, settles softly. */
export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Overshoots past 1 and settles back, for a "pop" without a spring engine. */
export function easeBack(t: number): number {
  const c = 1.70158;
  const inv = t - 1;
  return 1 + (c + 1) * inv * inv * inv + c * inv * inv;
}

/** Ramps up then back down — for one-shot flashes. */
export function pulse(t: number): number {
  return Math.sin(Math.min(Math.max(t, 0), 1) * Math.PI);
}

export interface BurstProps {
  progress: number;
  /** Particle count. Kept modest — every one is a re-rendered View. */
  count?: number;
  colors?: readonly string[];
  /** How far particles travel, in px. */
  radius?: number;
  size?: number;
}

/**
 * Radiating particle burst.
 *
 * Angles are deterministic (evenly spaced with a fixed per-index jitter) rather
 * than random, so the burst does not reshuffle on every re-render — which, with
 * a state-driven ticker, would happen 60 times a second and look like static.
 */
export function Burst({
  progress,
  count = 18,
  colors = ['#00B8D9', '#A78BFA', '#FBBF24', '#00B8D9'],
  radius = 150,
  size = 10,
}: BurstProps) {
  const travelled = easeOut(progress);
  const particles = [];

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (i % 3) * 0.18;
    // Alternating reach stops the burst reading as a perfect ring.
    const reach = radius * (i % 2 === 0 ? 1 : 0.72);
    const distance = travelled * reach;
    const opacity = progress < 0.75 ? 1 : Math.max(0, 1 - (progress - 0.75) / 0.25);

    particles.push(
      <View
        key={i}
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors[i % colors.length],
          opacity,
          transform: [
            { translateX: Math.cos(angle) * distance },
            { translateY: Math.sin(angle) * distance },
            { scale: 0.6 + 0.8 * (1 - travelled) },
          ],
        }}
      />,
    );
  }

  return (
    <View pointerEvents="none" style={{ alignItems: 'center', justifyContent: 'center' }}>
      {particles}
    </View>
  );
}

/** Expanding ring, used behind the burst for a shockwave read. */
export function Shockwave({
  progress,
  color = '#00B8D9',
  maxSize = 320,
}: {
  progress: number;
  color?: string;
  maxSize?: number;
}) {
  const t = easeOut(progress);
  const size = maxSize * t;
  const style: ViewStyle = {
    position: 'absolute',
    width: size,
    height: size,
    borderRadius: size / 2,
    opacity: Math.max(0, 1 - t) * 0.7,
  };
  return <View pointerEvents="none" style={style} />;
}
