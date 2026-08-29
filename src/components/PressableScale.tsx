import { useCallback } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import {
  hapticLight,
  hapticMedium,
  hapticSelection,
  hapticSuccess,
} from '@/lib/haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Snappy but soft. Tuned so the release overshoots very slightly — that tiny
 * bounce is what separates "responsive" from "mechanical".
 */
const PRESS_SPRING = { damping: 15, stiffness: 400, mass: 0.5 } as const;

export type HapticStyle = 'light' | 'selection' | 'medium' | 'success' | 'none';

const HAPTICS: Record<Exclude<HapticStyle, 'none'>, () => void> = {
  light: hapticLight,
  selection: hapticSelection,
  medium: hapticMedium,
  success: hapticSuccess,
};

export interface PressableScaleProps extends Omit<PressableProps, 'style'> {
  /** How far to compress. 0.95 for large surfaces, ~0.9 for small controls. */
  activeScale?: number;
  /**
   * Fired on press-IN, not on press, so the tap is confirmed the moment the
   * finger lands rather than after the gesture resolves.
   */
  haptic?: HapticStyle;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/**
 * The app's single pressable primitive: spring scale + haptic on every tap.
 *
 * Two reasons this exists rather than a `pressed`-state style callback:
 *  1. A style callback re-renders the component on every touch and snaps
 *     between two discrete values; a shared value animates on the UI thread.
 *  2. NativeWind `className` is silently DROPPED on Reanimated components, so
 *     the animated wrapper must be styled through `style`. Centralising that
 *     here keeps the trap in one file instead of every call site.
 */
export function PressableScale({
  activeScale = 0.95,
  haptic = 'light',
  style,
  children,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: PressableScaleProps) {
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - (1 - activeScale) * pressed.value }],
  }));

  const handlePressIn = useCallback<NonNullable<PressableProps['onPressIn']>>(
    (event) => {
      pressed.value = withSpring(1, PRESS_SPRING);
      if (haptic !== 'none') HAPTICS[haptic]();
      onPressIn?.(event);
    },
    [pressed, haptic, onPressIn],
  );

  const handlePressOut = useCallback<NonNullable<PressableProps['onPressOut']>>(
    (event) => {
      pressed.value = withSpring(0, PRESS_SPRING);
      onPressOut?.(event);
    },
    [pressed, onPressOut],
  );

  return (
    <AnimatedPressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      style={[style, animatedStyle, disabled ? { opacity: 0.45 } : null]}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}
