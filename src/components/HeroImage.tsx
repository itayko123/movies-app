import { useEffect, useMemo, useRef, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';

import { easeOut } from '@/components/Celebration';
import { takeHeroSource, type HeroRect } from '@/lib/heroHandoff';

/**
 * The detail screen's hero, animating in from wherever the poster was tapped.
 *
 * Reads the handoff rectangle ONCE on mount (see heroHandoff.ts) and
 * interpolates from it to the full hero frame. When there is no rectangle —
 * a deep link, a page refresh, or navigation from somewhere that does not
 * measure — it renders straight to the final frame with no animation at all.
 *
 * The completion backstop is the same one the celebration uses: if the frame
 * ticker never runs (background tab, throttled rAF), a timer forces the final
 * state. The hero is the primary content of this screen, so it must never be
 * left mid-transition at a fraction of its size.
 */
const DURATION = 320;

export function HeroImage({
  uri,
  height,
  children,
}: {
  uri: string | null;
  height: number;
  children?: React.ReactNode;
}) {
  const { width } = useWindowDimensions();
  // Captured once: consuming it in render would re-run under StrictMode's
  // double-invoke and swallow the rectangle before the animation could use it.
  const source = useRef<HeroRect | null | undefined>(undefined);
  if (source.current === undefined) source.current = takeHeroSource();

  const from = source.current;
  const [progress, setProgress] = useState(from ? 0 : 1);

  useEffect(() => {
    if (!from) return;
    const start = Date.now();
    let cancelled = false;
    let frame: number | null = null;

    const tick = () => {
      if (cancelled) return;
      const next = Math.min((Date.now() - start) / DURATION, 1);
      setProgress(next);
      if (next < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const settle = setTimeout(() => {
      if (!cancelled) setProgress(1);
    }, DURATION + 200);

    return () => {
      cancelled = true;
      clearTimeout(settle);
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [from]);

  const frame = useMemo(() => {
    const target = { x: 0, y: 0, width, height };
    if (!from) return target;
    const t = easeOut(progress);
    const lerp = (a: number, b: number) => a + (b - a) * t;
    return {
      x: lerp(from.x, target.x),
      y: lerp(from.y, target.y),
      width: lerp(from.width, target.width),
      height: lerp(from.height, target.height),
    };
  }, [from, progress, width, height]);

  const animating = progress < 1;

  return (
    // Reserves the final space immediately, so the page below never reflows as
    // the hero grows into place.
    <View style={{ height, width: '100%' }}>
      <View
        style={{
          position: 'absolute',
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
          overflow: 'hidden',
          // The poster it flew from had rounded corners; straighten them out
          // as it fills the frame or the corners pop at the end.
          borderRadius: animating ? 18 * (1 - easeOut(progress)) : 0,
          backgroundColor: '#121826',
        }}
      >
        {uri && (
          <Image
            source={{ uri }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            // No cross-fade during the flight: the poster is already on screen
            // from the previous route, so fading it in reads as a flicker.
            transition={animating ? 0 : 250}
            cachePolicy="memory-disk"
          />
        )}
        {/* Overlays (scrim, title) only once the hero has landed — they are
            sized for the full frame and would be squashed mid-flight. */}
        {!animating && children}
      </View>
    </View>
  );
}
