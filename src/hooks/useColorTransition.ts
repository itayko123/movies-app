import { useEffect, useRef, useState } from 'react';
import { hexToRgb } from '@/lib/contrast';

/**
 * Eases a colour toward a target, returning the intermediate value each tick.
 *
 * ── Why a timer and not an animation library ───────────────────────────────
 * The theme background used to cross-fade with Reanimated, which is inert
 * under react-native-web here — so on web the poster colour changed as a hard
 * cut, and the "smooth" transition existed only on device. requestAnimationFrame
 * is not an option either: it has been measured in this project not firing at
 * all while the page is not compositing.
 *
 * setInterval does fire in both cases, and because each step recomputes
 * progress from the CLOCK rather than incrementing a counter, a throttled or
 * skipped tick simply lands further along the curve instead of slowing the
 * whole transition down. A tab that was suspended mid-fade snaps to the final
 * colour on its first tick back.
 *
 * 25fps is deliberate: this drives a heavily damped background wash, where the
 * difference against 60fps is invisible and the wakeups are worth saving.
 */
const FPS = 25;

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

export function useColorTransition(target: string, duration = 700): string {
  const [value, setValue] = useState(target);
  /** Colour currently on screen — the start point for the NEXT transition. */
  const shown = useRef(target);

  useEffect(() => {
    const from = hexToRgb(shown.current);
    const to = hexToRgb(target);

    // Unparseable input (a named colour, an rgba string) is not a reason to
    // show the wrong colour — snap and carry on.
    if (!from || !to) {
      shown.current = target;
      setValue(target);
      return;
    }
    if (from.r === to.r && from.g === to.g && from.b === to.b) return;

    const start = Date.now();
    const id = setInterval(() => {
      const t = Math.min((Date.now() - start) / duration, 1);
      const eased = easeOut(t);
      const mix = (a: number, b: number) => Math.round(a + (b - a) * eased);
      const next = `#${[mix(from.r, to.r), mix(from.g, to.g), mix(from.b, to.b)]
        .map((channel) => channel.toString(16).padStart(2, '0'))
        .join('')}`;

      shown.current = next;
      setValue(next);
      if (t >= 1) clearInterval(id);
    }, 1000 / FPS);

    return () => clearInterval(id);
  }, [target, duration]);

  return value;
}
