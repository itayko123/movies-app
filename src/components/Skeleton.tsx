import { useEffect } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

export interface SkeletonProps {
  className?: string;
  style?: ViewStyle;
  /** Stagger multiple skeletons so the shimmer reads as a wave. */
  delay?: number;
}

/**
 * Pulsing placeholder shown for every network-backed surface.
 *
 * The sizing classes live on a plain View: NativeWind `className` is not
 * applied to Reanimated's Animated.View, so putting them there would leave
 * the skeleton with no size at all. The Animated.View is an absolute-fill
 * overlay that only drives opacity.
 */
export function Skeleton({ className, style, delay = 0 }: SkeletonProps) {
  const progress = useSharedValue(0.3);

  useEffect(() => {
    progress.value = withDelay(
      delay,
      withRepeat(
        withTiming(0.85, { duration: 900, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      ),
    );
  }, [progress, delay]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  return (
    <View
      className={`bg-card rounded-2xl overflow-hidden${className ? ` ${className}` : ''}`}
      style={style}
      accessibilityRole="progressbar"
      accessible={false}
    >
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: '#242430' }, animatedStyle]}
      />
    </View>
  );
}

/** Full-screen deck placeholder. */
export function DeckSkeleton() {
  return (
    <View className="flex-1 items-center justify-center">
      <Skeleton className="w-full flex-1 rounded-hero" />
      <View className="h-6" />
      <View className="flex-row gap-5">
        <Skeleton className="w-[68px] h-[68px] rounded-full" delay={80} />
        <Skeleton className="w-14 h-14 rounded-full" delay={160} />
        <Skeleton className="w-[68px] h-[68px] rounded-full" delay={240} />
      </View>
    </View>
  );
}

/** Horizontal row of poster placeholders (mood results, watchlist). */
export function PosterRowSkeleton({ count = 3 }: { count?: number }) {
  return (
    <View className="flex-row gap-3">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="w-32 h-48 rounded-2xl" delay={i * 90} />
      ))}
    </View>
  );
}
