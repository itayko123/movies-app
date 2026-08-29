import { useEffect, useRef, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';

/**
 * Slow drifting glow behind the app.
 *
 * ── Why a timer and not an animation library ───────────────────────────────
 * Same constraint as the celebration: Reanimated animated styles are inert
 * under react-native-web here, so a Reanimated version would drift on device
 * and sit perfectly still on the web build. This uses a low-frequency state
 * tick instead, which behaves identically everywhere.
 *
 * ── Why the frequency is so low ────────────────────────────────────────────
 * This is the ONE always-on animation in the app; everything else is a
 * one-shot. At 60fps it would re-render the root of the tree forever, for an
 * effect nobody is looking at directly, and it would keep the CPU awake and
 * eat battery. 4fps is imperceptible for motion this slow — the blobs move a
 * few pixels a second — and costs essentially nothing.
 *
 * It also respects the poster palette, so the ambient colour is already the
 * colour of whatever the user is looking at.
 */

/** Ticks per second. Deliberately tiny — see the note above. */
const FPS = 4;
/** Seconds for one full drift cycle. */
const PERIOD = 34;

/**
 * Colours arrive as PROPS, not from `useTheme`.
 *
 * ThemeProvider renders this component, so reading the theme context from
 * inside it would make the two modules import each other. ES modules tolerate
 * that cycle right up until evaluation order changes and one side is briefly
 * `undefined` — a crash that only shows up after an unrelated refactor. Props
 * remove the cycle entirely.
 */
export function AmbientBackdrop({
  primary,
  secondary,
}: {
  primary: string;
  secondary: string;
}) {
  const { width, height } = useWindowDimensions();
  const [phase, setPhase] = useState(0);
  const start = useRef(Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      const elapsed = (Date.now() - start.current) / 1000;
      setPhase((elapsed % PERIOD) / PERIOD);
    }, 1000 / FPS);
    return () => clearInterval(id);
  }, []);

  const angle = phase * Math.PI * 2;
  // Two blobs on opposing orbits, so the field never looks like one moving dot.
  const blobs = [
    {
      color: primary,
      size: Math.max(width, height) * 0.85,
      x: width * 0.5 + Math.cos(angle) * width * 0.22 - Math.max(width, height) * 0.425,
      y: height * 0.3 + Math.sin(angle) * height * 0.12 - Math.max(width, height) * 0.425,
      opacity: 0.1,
    },
    {
      color: secondary,
      size: Math.max(width, height) * 0.7,
      x: width * 0.5 - Math.cos(angle * 0.8) * width * 0.26 - Math.max(width, height) * 0.35,
      y: height * 0.72 - Math.sin(angle * 0.8) * height * 0.1 - Math.max(width, height) * 0.35,
      opacity: 0.08,
    },
  ];

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}
    >
      {blobs.map((blob, index) => (
        <View
          key={index}
          style={{
            position: 'absolute',
            left: blob.x,
            top: blob.y,
            width: blob.size,
            height: blob.size,
            borderRadius: blob.size / 2,
            backgroundColor: blob.color,
            opacity: blob.opacity,
          }}
        />
      ))}
    </View>
  );
}
