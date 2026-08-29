import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { AmbientBackdrop } from '@/components/AmbientBackdrop';
import { useColorTransition } from '@/hooks/useColorTransition';
import { useAppStore, type Palette } from '@/state/store';
import { readableTextOn, needsDarkScrim } from '@/lib/contrast';

interface ThemeContextValue {
  palette: Palette;
  /** Text color guaranteed to pass WCAG AA over the current palette. */
  textOnPalette: string;
  /** True when typography over this palette must sit on a dark scrim. */
  requiresScrim: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  palette: {
    primary: '#00B8D9',
    secondary: '#00B8D9',
    isLight: false,
    posterUrl: null,
  },
  textOnPalette: '#FAFAFA',
  requiresScrim: false,
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/**
 * Animated background driven by the focused poster's dominant color, blended
 * down toward OLED black so the palette reads as a glow rather than a wash.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const palette = useAppStore((s) => s.palette);

  const value = useMemo<ThemeContextValue>(
    () => ({
      palette,
      textOnPalette: readableTextOn(palette.primary),
      requiresScrim: needsDarkScrim(palette.primary),
    }),
    [palette],
  );

  /**
   * Poster-driven background.
   *
   * The colour is INTERPOLATED in JS and applied to plain Views. Two earlier
   * bugs shaped this:
   *
   *  1. `withTiming(1)` inside a `useDerivedValue` with an empty dep array, so
   *     `progress` reached 1 on mount and never moved again.
   *  2. Reanimated animated styles are inert under react-native-web in this
   *     project, so the cross-fade that replaced it ran on device and produced
   *     a hard cut on web — a "smooth transition" that was only ever smooth on
   *     half the targets.
   *
   * useColorTransition steps the colour on a clock-driven timer instead, which
   * fires on every platform and degrades gracefully if ticks are throttled.
   * Both stops move, so the accent gradient shifts as a whole rather than one
   * layer sliding under a fixed one.
   */
  const primary = useColorTransition(palette.primary, 700);
  const secondary = useColorTransition(palette.secondary, 700);

  return (
    <ThemeContext.Provider value={value}>
      <View className="flex-1 bg-app">
        {/* Live palette glow, heavily damped so the dark base stays dominant. */}
        <View
          style={[
            StyleSheet.absoluteFillObject,
            { opacity: 0.12, pointerEvents: 'none', backgroundColor: primary },
          ]}
        />
        {/* Accent gradient: a wash of the poster's secondary across the top,
            which is what makes the whole screen feel keyed to the artwork
            rather than just tinted behind it. */}
        <LinearGradient
          colors={[`${secondary}59`, 'transparent']}
          locations={[0, 1]}
          style={[StyleSheet.absoluteFillObject, { pointerEvents: 'none' }]}
        />
        {/* Slow drifting glow. Sits above the flat palette wash and below the
            gradient, so the motion is felt rather than seen. */}
        <AmbientBackdrop primary={primary} secondary={secondary} />
        <LinearGradient
          colors={['rgba(0,0,0,0.35)', 'rgba(0,0,0,0.85)', '#000000']}
          locations={[0, 0.55, 1]}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            pointerEvents: 'none',
          }}
        />
        {children}
      </View>
    </ThemeContext.Provider>
  );
}

/**
 * Dark gradient placed behind typography over artwork.
 * Deepens automatically when the extracted palette is too light for white text.
 */
export function ContrastScrim({ intense }: { intense?: boolean }) {
  const { requiresScrim } = useTheme();
  const strong = intense || requiresScrim;

  return (
    <LinearGradient
      colors={
        strong
          ? ['transparent', 'rgba(0,0,0,0.72)', 'rgba(0,0,0,0.94)']
          : ['transparent', 'rgba(0,0,0,0.45)', 'rgba(0,0,0,0.82)']
      }
      locations={[0, 0.55, 1]}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: '62%',
        pointerEvents: 'none',
      }}
    />
  );
}
