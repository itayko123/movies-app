/**
 * WCAG contrast utilities for the dynamic poster-driven theme.
 *
 * Poster palettes are uncontrolled input: an all-white poster would make
 * white typography vanish. Every extracted color passes through here before
 * it is allowed behind text.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb | null {
  const normalized = hex.trim().replace('#', '');
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return null;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance, 0 (black) … 1 (white). */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return (
    0.2126 * channelToLinear(rgb.r) +
    0.7152 * channelToLinear(rgb.g) +
    0.0722 * channelToLinear(rgb.b)
  );
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * True when a color is too light to sit behind white text.
 * 0.55 luminance ≈ where white text drops below the 4.5:1 AA ratio.
 */
export function isLightColor(hex: string, threshold = 0.55): boolean {
  return relativeLuminance(hex) > threshold;
}

/** Text color guaranteed to hit AA contrast on the given background. */
export function readableTextOn(backgroundHex: string): '#FAFAFA' | '#0B0B0E' {
  return contrastRatio(backgroundHex, '#FAFAFA') >= 4.5 ? '#FAFAFA' : '#0B0B0E';
}

/**
 * Whether typography over this palette needs the dark gradient scrim.
 * Used by SwipeCard and the detail hero: if the poster's dominant color is
 * light, a black→transparent LinearGradient is placed behind the text layer.
 */
export function needsDarkScrim(dominantHex: string): boolean {
  return isLightColor(dominantHex);
}
