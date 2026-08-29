import { memo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { C } from '@/theme/tokens';

interface ConcentricRingsProps {
  /** Number of rings. The reference welcome screens show 5–6. */
  count?: number;
  /** Radius of the innermost ring, in px. */
  innerRadius?: number;
  /** Distance between rings, in px. */
  spacing?: number;
  /** Ring colour. Defaults to a barely-there light stroke like the reference. */
  color?: string;
  /** Peak stroke opacity. */
  maxOpacity?: number;
}

/**
 * The slow-breathing ring field behind the logo on the welcome screen.
 *
 * Two implementation notes that matter:
 *
 *  1. Rings are SVG `stroke`, NOT a bordered View. A View ring would need
 *     `borderWidth`, which this design system forbids outright (see
 *     scripts/check-tokens.js) — SVG is the primitive that gives a hairline
 *     circle without a box border.
 *  2. Nothing animates an SVG prop. Each ring is a static <Svg> wrapped in its
 *     own Animated.View, and only `transform`/`opacity` are driven. Those two
 *     are the properties Reanimated can mutate entirely on the UI thread with
 *     no layout pass and no re-render, so the field costs ~nothing per frame
 *     even while the deck-quality springs run elsewhere.
 *
 * Each ring runs the same loop offset by a stagger, which is what produces the
 * outward "pulse travelling through the rings" read rather than N circles
 * throbbing in unison.
 */
function ConcentricRingsImpl({
  count = 6,
  innerRadius = 70,
  spacing = 46,
  color = 'rgba(148,163,184,0.30)',
  maxOpacity = 1,
}: ConcentricRingsProps) {
  const { width, height } = useWindowDimensions();
  // Rings are centred on the logo, which sits above centre on the welcome
  // screen; oversizing past the viewport keeps the outer rings off-screen so
  // they read as "continuing" rather than as drawn circles.
  const field = Math.max(width, height) * 1.6;

  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
    >
      {Array.from({ length: count }, (_, i) => (
        <Ring
          key={i}
          index={i}
          radius={innerRadius + i * spacing}
          field={field}
          color={color}
          maxOpacity={maxOpacity}
        />
      ))}
    </View>
  );
}

function Ring({
  index,
  radius,
  field,
  color,
  maxOpacity,
}: {
  index: number;
  radius: number;
  field: number;
  color: string;
  maxOpacity: number;
}) {
  const progress = useSharedValue(0);
  const reduceMotion = useReducedMotion();

  // Start the loop once. Ring N lags ring N-1 by 240ms, so the pulse reads as
  // travelling outward from the logo.
  if (progress.value === 0 && !reduceMotion) {
    progress.value = withDelay(
      index * 240,
      withRepeat(
        withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
        -1,
        true,
      ),
    );
  }

  const style = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      transform: [{ scale: 1 + p * 0.045 }],
      // Outer rings sit fainter so the field falls off toward the edges.
      opacity: (0.85 - index * 0.11) * (0.55 + p * 0.45) * maxOpacity,
    };
  });

  const size = radius * 2;

  return (
    <Animated.View style={[{ position: 'absolute', width: size, height: size }, style]}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle
          cx={radius}
          cy={radius}
          r={radius - 1}
          stroke={color}
          strokeWidth={1.5}
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}

export const ConcentricRings = memo(ConcentricRingsImpl);

/** Exported so the welcome screen can tint the field to the accent. */
export const RING_ACCENT = C.accentSoft;
