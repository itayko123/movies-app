import type { ReactNode } from 'react';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';
import { BlurView } from 'expo-blur';
import { BLUR, C, SHADOW } from '@/theme/tokens';

export type GlassTone = 'panel' | 'bar' | 'chip' | 'sheet';

export interface GlassViewProps extends ViewProps {
  children?: ReactNode;
  /** Preset that picks blur strength, fill opacity and depth. */
  tone?: GlassTone;
  /** Override the preset's blur intensity. */
  intensity?: number;
  /** Drop the shadow (e.g. for glass nested inside glass). */
  flat?: boolean;
  className?: string;
}

const TONE = {
  /** Standard content card. */
  panel: { blur: BLUR.soft, fill: C.surfaceGlass, shadow: SHADOW.card },
  /** Sticky top/bottom bars — heaviest blur, so content reads through it. */
  bar: { blur: BLUR.heavy, fill: C.surfaceGlassStrong, shadow: SHADOW.bar },
  /** Small inline controls. Light touch, no shadow. */
  chip: { blur: BLUR.soft, fill: C.chip, shadow: null },
  /** Bottom sheet body. */
  sheet: { blur: BLUR.medium, fill: C.surfaceGlassStrong, shadow: SHADOW.raised },
} as const;

/**
 * Glassmorphism container — the primary surface of "Cinematic Midnight".
 *
 * Three things make this read as real glass rather than a grey box:
 *
 *  1. A genuine BlurView samples what is BEHIND it, so it picks up poster
 *     colour and shifts as content scrolls under it.
 *  2. The fill on top is translucent navy, never opaque — an opaque fill
 *     would waste the blur entirely (the bug in the previous design).
 *  3. Depth comes from a shadow, NOT a border. This component deliberately
 *     exposes no border prop; see scripts/check-tokens.js.
 *
 * Android caps blur far lower than iOS (BlurView is expensive there and
 * degrades badly), so the fill carries proportionally more of the effect.
 * Web maps to backdrop-filter, which needs no cap.
 *
 * All padding/margin passed via className MUST use logical properties
 * (ps-/pe-/ms-/me-) so the layout mirrors under RTL.
 */
export function GlassView({
  children,
  tone = 'panel',
  intensity,
  flat = false,
  className,
  style,
  ...rest
}: GlassViewProps) {
  const preset = TONE[tone];
  const blur = intensity ?? preset.blur;

  return (
    <View
      className={`overflow-hidden${className ? ` ${className}` : ''}`}
      style={[!flat && preset.shadow ? preset.shadow : null, style]}
      {...rest}
    >
      <BlurView
        intensity={Platform.OS === 'android' ? Math.min(blur, 32) : blur}
        tint="dark"
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor:
              Platform.OS === 'android' ? C.surfaceGlassStrong : preset.fill,
            pointerEvents: 'none',
          },
        ]}
      />
      {children}
    </View>
  );
}
