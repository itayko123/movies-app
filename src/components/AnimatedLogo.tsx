import { useEffect } from 'react';
import { Platform, View } from 'react-native';
import Svg, { Circle, Defs, Path, RadialGradient, Stop } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { C } from '@/theme/tokens';

/**
 * Camera-aperture brand mark, drawn on a 120×120 grid.
 *
 * Replaces an earlier ת lettermark, which was rejected — correctly. A Hebrew
 * character in a circle says nothing about what the product IS, and reads as a
 * font choice rather than a designed mark. An iris says CINEMA instantly, in
 * any language, and it is the one camera motif that still reads when shrunk to
 * a 24px tab icon.
 *
 * Construction — a real iris, not six decorative spokes:
 *   - a hexagonal opening at radius OPENING
 *   - from each hexagon vertex, one blade edge runs out to the barrel, swept
 *     BLADE_SWEEP° OFF-RADIAL. That tangential sweep is the whole trick: at 0°
 *     it degenerates into a wagon wheel; at ~38° the eye reads overlapping
 *     blades and the shape becomes a shutter.
 */
const CENTER = 60;
const BARREL = 46;
const OPENING = 22;
const BLADE_TIP = 44;
const BLADE_SWEEP = 38;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const point = (angleDeg: number, radius: number) => ({
  x: CENTER + Math.cos(toRad(angleDeg)) * radius,
  y: CENTER + Math.sin(toRad(angleDeg)) * radius,
});

/** Six blade edges. */
const BLADES = Array.from({ length: 6 }, (_, i) => {
  const base = 30 + i * 60;
  const from = point(base, OPENING);
  const to = point(base + BLADE_SWEEP, BLADE_TIP);
  return `M${from.x.toFixed(2)} ${from.y.toFixed(2)} L${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
});

/** The opening the blades enclose. */
const HEX = (() => {
  const pts = Array.from({ length: 6 }, (_, i) => point(30 + i * 60, OPENING));
  return (
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + ' Z'
  );
})();

export interface AnimatedLogoProps {
  /** Outer diameter in px, including the halo. */
  size?: number;
  /** Skips the entry animation (for a logo that is already on screen). */
  static?: boolean;
}

/**
 * Pulsing aperture — the app's animated brand mark.
 *
 * Motion is layered on one clock so it breathes rather than blinks:
 *  - a cyan halo expands and dissolves (2.6s),
 *  - the iris "stops down": the blade group scales slightly, exactly like a
 *    lens adjusting — the single most cinematic thing this mark can do,
 *  - the light through the centre brightens on the same beat,
 *  - the iris rotates once per 30s, slow enough to be felt, not watched.
 *
 * Everything animates `transform`/`opacity` on Animated.Views wrapping static
 * SVG. No SVG prop is animated, so the mark costs one UI-thread worklet per
 * layer and never triggers a React re-render.
 *
 * Entry starts at 0.92, not 0: this mounts the instant the native splash is
 * dismissed, and springing up from nothing reads as a second, competing intro.
 */
export function AnimatedLogo({ size = 200, static: isStatic = false }: AnimatedLogoProps) {
  const reduceMotion = useReducedMotion();
  /**
   * Reanimated animated styles are INERT under react-native-web in this
   * project, so a shared value initialised to 0 stays 0 forever there — an
   * entry fading in from `opacity: 0` would render a permanently invisible
   * logo. CONTENT VISIBILITY MUST NEVER DEPEND ON AN ANIMATION COMPLETING:
   * where motion cannot run, values start finished and the mark is static.
   */
  const inert = Platform.OS === 'web' || reduceMotion;
  const pulse = useSharedValue(0);
  const spin = useSharedValue(0);
  const entry = useSharedValue(isStatic || inert ? 1 : 0);

  useEffect(() => {
    if (inert) return;
    if (!isStatic) {
      entry.value = withSpring(1, { damping: 16, stiffness: 130, mass: 0.9 });
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    spin.value = withRepeat(withTiming(1, { duration: 30000, easing: Easing.linear }), -1, false);
  }, [entry, pulse, spin, isStatic, inert]);

  const entryStyle = useAnimatedStyle(() => ({
    opacity: entry.value,
    transform: [{ scale: 0.92 + entry.value * 0.08 }],
  }));

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.55 - pulse.value * 0.45,
    transform: [{ scale: 0.92 + pulse.value * 0.34 }],
  }));

  /** The lens stopping down. */
  const irisStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }, { scale: 1 - pulse.value * 0.06 }],
  }));

  const lightStyle = useAnimatedStyle(() => ({
    opacity: 0.45 + pulse.value * 0.4,
  }));

  const discStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pulse.value * 0.03 }],
  }));

  const disc = size * 0.78;

  return (
    <Animated.View
      style={[
        { width: size, height: size, alignItems: 'center', justifyContent: 'center' },
        entryStyle,
      ]}
      accessibilityRole="image"
      accessibilityLabel="תבחר לי סרט"
    >
      {/* Breathing halo — a soft cyan bloom that expands and dissolves. */}
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: C.accentGlow,
          },
          haloStyle,
        ]}
      />

      <Animated.View
        style={[
          {
            width: disc,
            height: disc,
            borderRadius: disc / 2,
            backgroundColor: C.surfaceRaised,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          },
          discStyle,
        ]}
      >
        {/* Light through the lens, behind the blades. */}
        <Animated.View style={[{ position: 'absolute' }, lightStyle]}>
          <Svg width={disc} height={disc} viewBox="0 0 120 120">
            <Defs>
              <RadialGradient id="lensLight" cx="50%" cy="50%" r="50%">
                <Stop offset="0%" stopColor={C.accent} stopOpacity={0.85} />
                <Stop offset="55%" stopColor={C.accent} stopOpacity={0.22} />
                <Stop offset="100%" stopColor={C.accent} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx={CENTER} cy={CENTER} r={34} fill="url(#lensLight)" />
          </Svg>
        </Animated.View>

        {/* Barrel — static, so the rotation below reads against it. */}
        <Svg width={disc} height={disc} viewBox="0 0 120 120" style={{ position: 'absolute' }}>
          <Circle
            cx={CENTER}
            cy={CENTER}
            r={BARREL}
            stroke={C.accent}
            strokeWidth={3}
            fill="none"
            opacity={0.9}
          />
          <Circle
            cx={CENTER}
            cy={CENTER}
            r={BARREL - 7}
            stroke={C.accent}
            strokeWidth={1}
            fill="none"
            opacity={0.35}
          />
        </Svg>

        {/* The iris: six blade edges around the hexagonal opening. */}
        <Animated.View style={[{ position: 'absolute' }, irisStyle]}>
          <Svg width={disc} height={disc} viewBox="0 0 120 120">
            {BLADES.map((d) => (
              <Path
                key={d}
                d={d}
                stroke={C.accent}
                strokeWidth={5}
                strokeLinecap="round"
                fill="none"
              />
            ))}
            <Path
              d={HEX}
              stroke={C.text}
              strokeWidth={3.2}
              strokeLinejoin="round"
              fill="none"
              opacity={0.92}
            />
          </Svg>
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

/** Static mark for headers/nav, where a looping pulse would be noise. */
export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: C.surfaceRaised,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <Svg width={size} height={size} viewBox="0 0 120 120">
        <Circle cx={CENTER} cy={CENTER} r={BARREL} stroke={C.accent} strokeWidth={5} fill="none" />
        {BLADES.map((d) => (
          <Path key={d} d={d} stroke={C.accent} strokeWidth={6} strokeLinecap="round" fill="none" />
        ))}
        <Path d={HEX} stroke={C.text} strokeWidth={4} strokeLinejoin="round" fill="none" />
      </Svg>
    </View>
  );
}
