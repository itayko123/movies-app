import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

/**
 * Fires when the device is shaken.
 *
 * ── Two implementations, one hook ──────────────────────────────────────────
 * Native uses expo-sensors' Accelerometer. Web uses the DeviceMotion event,
 * which is a different API with different units and — on iOS Safari — requires
 * a user-gesture-triggered permission call that a hook cannot make on its own.
 * Both are wrapped in try/catch: shake is an ACCELERATOR, never the only way to
 * reach the feature (the wand button always works), so any failure here is
 * silent by design rather than something to surface.
 *
 * ── Why the threshold is on jerk, not magnitude ────────────────────────────
 * Total acceleration is ~1g at rest and rises smoothly when you simply pick the
 * phone up, so a magnitude threshold fires constantly in a pocket. A shake is
 * characterised by rapid REVERSALS, so this looks at the change between
 * samples and requires several in quick succession.
 */
const SHAKE_DELTA = 1.8;
/** Reversals needed inside the window before it counts as a shake. */
const SHAKE_COUNT = 3;
const WINDOW_MS = 700;
/** Ignore further shakes for this long, so one shake fires exactly once. */
const COOLDOWN_MS = 2000;

export function useShake(onShake: () => void, enabled = true): void {
  // Kept in a ref so a re-created callback does not tear down the subscription
  // (which on native means unsubscribing and resubscribing to the sensor).
  const handler = useRef(onShake);
  handler.current = onShake;

  useEffect(() => {
    if (!enabled) return;

    let last = { x: 0, y: 0, z: 0 };
    let hits: number[] = [];
    let lastFired = 0;
    let primed = false;

    const consider = (x: number, y: number, z: number) => {
      if (!primed) {
        last = { x, y, z };
        primed = true;
        return;
      }
      const delta =
        Math.abs(x - last.x) + Math.abs(y - last.y) + Math.abs(z - last.z);
      last = { x, y, z };
      if (delta < SHAKE_DELTA) return;

      const now = Date.now();
      hits = hits.filter((at) => now - at < WINDOW_MS);
      hits.push(now);

      if (hits.length >= SHAKE_COUNT && now - lastFired > COOLDOWN_MS) {
        lastFired = now;
        hits = [];
        handler.current();
      }
    };

    if (Platform.OS === 'web') {
      // DeviceMotion reports m/s^2, so ~9.8 at rest on one axis. The delta
      // comparison above is scale-independent, but the threshold is tuned for
      // g-units, so normalise here.
      const onMotion = (event: DeviceMotionEvent) => {
        const a = event.accelerationIncludingGravity;
        if (!a || a.x == null || a.y == null || a.z == null) return;
        consider(a.x / 9.81, a.y / 9.81, a.z / 9.81);
      };

      try {
        window.addEventListener('devicemotion', onMotion);
      } catch {
        return;
      }
      return () => window.removeEventListener('devicemotion', onMotion);
    }

    let subscription: { remove: () => void } | null = null;
    try {
      // Required lazily: on a platform without the native module this import
      // throws, and it must not take the screen down with it.
      const { Accelerometer } = require('expo-sensors') as typeof import('expo-sensors');
      Accelerometer.setUpdateInterval(100);
      subscription = Accelerometer.addListener(({ x, y, z }) => consider(x, y, z));
    } catch {
      subscription = null;
    }

    return () => subscription?.remove();
  }, [enabled]);
}
