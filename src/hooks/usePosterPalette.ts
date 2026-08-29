import { useEffect } from 'react';
import { useAppStore, DEFAULT_PALETTE, type Palette } from '@/state/store';
import { isLightColor } from '@/lib/contrast';
import { extractPosterColors } from '@/lib/posterColors';

/**
 * Dynamic poster-colour extraction.
 *
 * The mechanism is platform-split (see src/lib/posterColors.*):
 *   • web    — canvas histogram. TMDB's CDN sends `Access-Control-Allow-Origin: *`,
 *              so the image can be drawn and read back without tainting.
 *   • native — `react-native-image-colors`, lazily required behind an Expo Go
 *              guard.
 *   • Expo Go — no pixel access exists, so the default palette is kept. The
 *              theme degrades; nothing breaks.
 *
 * Returning null from the extractor always means "leave the theme alone", never
 * "reset it" — a failed extraction should not flash the deck back to brand pink.
 */

// Extraction is network + decode work; cache per URL so re-focusing a card
// never re-extracts.
const cache = new Map<string, Palette>();

export async function extractPalette(posterUrl: string): Promise<Palette | null> {
  const cached = cache.get(posterUrl);
  if (cached) return cached;

  const colors = await extractPosterColors(posterUrl).catch(() => null);
  if (!colors) return null;

  const palette: Palette = {
    primary: colors.primary,
    secondary: colors.secondary,
    // Drives the dark scrim behind typography — a white poster must never
    // leave white text floating on white.
    isLight: isLightColor(colors.primary),
    posterUrl,
  };

  cache.set(posterUrl, palette);
  return palette;
}

/**
 * Extracts and applies the palette of the currently focused poster.
 * Pass null to leave the palette untouched (e.g. while a card animates out).
 */
export function usePosterPalette(posterUrl: string | null): void {
  const setPalette = useAppStore((s) => s.setPalette);

  useEffect(() => {
    if (!posterUrl) return;
    let cancelled = false;

    extractPalette(posterUrl)
      .then((palette) => {
        if (!cancelled && palette) setPalette(palette);
      })
      .catch(() => {
        // Extraction can fail on unreachable images; keep the previous theme.
      });

    return () => {
      cancelled = true;
    };
  }, [posterUrl, setPalette]);
}

/** Warms the palette cache for upcoming cards (no state writes). */
export function prefetchPalettes(urls: Array<string | null>): void {
  for (const url of urls) {
    if (url && !cache.has(url)) {
      extractPalette(url).catch(() => undefined);
    }
  }
}

/** Resets to the brand palette (used when no card is focused). */
export function defaultPalette(): Palette {
  return DEFAULT_PALETTE;
}
