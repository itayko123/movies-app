import { View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { C } from '@/theme/tokens';

/**
 * The reference's page dots: inactive dots are small and dim, the active one is
 * brighter and stretched into a short capsule.
 *
 * The active dot is driven by the carousel's FRACTIONAL page, so width and
 * opacity move continuously with a drag rather than snapping when the page
 * commits. That is read off a shared value inside `useAnimatedStyle`, so the
 * whole thing costs zero JS per frame — which is the point of the exercise.
 *
 * Where animated styles cannot run (web, reduced motion) the animated path
 * would leave every dot frozen at its initial value, so a plain static variant
 * is rendered from a whole-number index instead. Same look, no interpolation.
 */

const SIZE = 6;
const ACTIVE_WIDTH = 18;
const GAP = 6;

export interface PageDotsProps {
  count: number;
  /** Fractional logical page. Ignored when `inert`. */
  progress: SharedValue<number>;
  /** Whole logical page, used when `inert`. */
  inertIndex: number;
  inert: boolean;
}

function AnimatedDot({ index, progress }: { index: number; progress: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    // Distance from this dot to the current page, clamped to one page either
    // side so only the two dots adjacent to a drag ever react.
    const distance = Math.min(Math.abs(progress.value - index), 1);
    return {
      width: interpolate(distance, [0, 1], [ACTIVE_WIDTH, SIZE]),
      opacity: interpolate(distance, [0, 1], [1, 0.32]),
    };
  });

  return (
    <Animated.View
      style={[{ height: SIZE, borderRadius: SIZE / 2, backgroundColor: C.text }, style]}
    />
  );
}

export function PageDots({ count, progress, inertIndex, inert }: PageDotsProps) {
  if (count < 2) return null;

  return (
    <View
      className="flex-row items-center justify-center"
      style={{ gap: GAP }}
      accessibilityRole="tablist"
      // The dots mirror with the row under RTL because the container is a
      // logical flex-row — no manual flip needed here.
    >
      {Array.from({ length: count }, (_, index) =>
        inert ? (
          <View
            key={index}
            style={{
              width: index === inertIndex ? ACTIVE_WIDTH : SIZE,
              height: SIZE,
              borderRadius: SIZE / 2,
              backgroundColor: C.text,
              opacity: index === inertIndex ? 1 : 0.32,
            }}
          />
        ) : (
          <AnimatedDot key={index} index={index} progress={progress} />
        ),
      )}
    </View>
  );
}
