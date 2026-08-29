import { memo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Platform } from 'react-native';

/**
 * Ambient cinematic glows — the layer that stops the welcome screen reading as
 * "a black screen with a logo on it".
 *
 * Why SVG and not a LinearGradient: what makes a room feel lit is a POINT of
 * light falling off in every direction. `expo-linear-gradient` can only ramp
 * along one axis, which is why the previous attempt still looked flat — it was
 * a wash, not a light source. `RadialGradient` gives real falloff.
 *
 * Two lights, deliberately different temperatures:
 *   - a WARM amber key light, upper-start. Warmth is what the brief was
 *     missing; an all-cyan screen reads clinical, not cinematic.
 *   - a COOL cyan fill, lower-end, tying the glow to the brand accent.
 *
 * They drift on long, mismatched loops (17s / 23s). Because the periods do not
 * divide evenly the pair never returns to the same arrangement, so the light
 * keeps changing instead of visibly looping.
 */
function CinematicGlowImpl() {
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const inert = Platform.OS === 'web' || reduceMotion;

  const warm = useSharedValue(0);
  const cool = useSharedValue(0);

  if (!inert && warm.value === 0) {
    warm.value = withRepeat(
      withTiming(1, { duration: 17000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    cool.value = withRepeat(
      withTiming(1, { duration: 23000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }

  const warmStyle = useAnimatedStyle(() => ({
    opacity: 0.72 + warm.value * 0.28,
    transform: [
      { translateX: -width * 0.12 + warm.value * width * 0.16 },
      { translateY: -height * 0.06 + warm.value * height * 0.05 },
      { scale: 1 + warm.value * 0.12 },
    ],
  }));

  const coolStyle = useAnimatedStyle(() => ({
    opacity: 0.66 + cool.value * 0.34,
    transform: [
      { translateX: width * 0.14 - cool.value * width * 0.2 },
      { translateY: height * 0.1 - cool.value * height * 0.06 },
      { scale: 1.05 - cool.value * 0.12 },
    ],
  }));

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {/* Warm key light */}
      <Animated.View style={[StyleSheet.absoluteFill, warmStyle]}>
        <Svg width={width} height={height}>
          <Defs>
            <RadialGradient id="warmKey" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor="#FF9A3C" stopOpacity={0.5} />
              <Stop offset="45%" stopColor="#C2410C" stopOpacity={0.22} />
              <Stop offset="100%" stopColor="#7C2D12" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse
            cx={width * 0.3}
            cy={height * 0.3}
            rx={width * 0.78}
            ry={height * 0.4}
            fill="url(#warmKey)"
          />
        </Svg>
      </Animated.View>

      {/* Cool fill light */}
      <Animated.View style={[StyleSheet.absoluteFill, coolStyle]}>
        <Svg width={width} height={height}>
          <Defs>
            <RadialGradient id="coolFill" cx="50%" cy="50%" r="50%">
              <Stop offset="0%" stopColor="#00B8D9" stopOpacity={0.45} />
              <Stop offset="50%" stopColor="#0E7490" stopOpacity={0.2} />
              <Stop offset="100%" stopColor="#082F49" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse
            cx={width * 0.72}
            cy={height * 0.68}
            rx={width * 0.8}
            ry={height * 0.38}
            fill="url(#coolFill)"
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

export const CinematicGlow = memo(CinematicGlowImpl);
