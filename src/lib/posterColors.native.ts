import { IS_EXPO_GO } from '@/lib/runtime';

/**
 * Poster colour extraction on native, via `react-native-image-colors`.
 *
 * The module is NOT bundled in Expo Go, so it is resolved lazily behind a
 * guard — a top-level import throws "Cannot find native module 'ImageColors'"
 * while Metro is still building the module graph, taking the app down before it
 * renders anything.
 *
 * KNOWN LIMITATION: in Expo Go there is no way to read image pixels at all
 * (no native module, no canvas), so the app keeps its default palette there.
 * The dynamic poster theme is visible on web and in a dev build
 * (`expo run:ios` / EAS dev client), not in Expo Go.
 */

export interface ExtractedColors {
  primary: string;
  secondary: string;
}

type ImageColorsApi = typeof import('react-native-image-colors').default;

// `undefined` = not resolved yet, `null` = unavailable on this runtime.
let api: ImageColorsApi | null | undefined;

function getApi(): ImageColorsApi | null {
  if (api !== undefined) return api;
  if (IS_EXPO_GO) {
    api = null;
    return null;
  }
  try {
    api = require('react-native-image-colors').default as ImageColorsApi;
  } catch (error) {
    if (__DEV__) console.warn('react-native-image-colors unavailable:', error);
    api = null;
  }
  return api;
}

function normalizeHex(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  // Android returns #AARRGGBB for some entries — drop the alpha byte.
  if (/^#[0-9a-fA-F]{8}$/.test(color)) return `#${color.slice(3)}`;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

export async function extractPosterColors(url: string): Promise<ExtractedColors | null> {
  const colors = getApi();
  if (!colors) return null;

  const result = await colors.getColors(url, {
    fallback: '#00B8D9',
    cache: true,
    key: url,
    quality: 'low',
  });

  if (result.platform === 'ios') {
    return {
      primary: normalizeHex(result.background, '#00B8D9'),
      secondary: normalizeHex(result.primary, '#A78BFA'),
    };
  }
  if (result.platform === 'android') {
    return {
      primary: normalizeHex(result.dominant, '#00B8D9'),
      secondary: normalizeHex(result.vibrant, '#A78BFA'),
    };
  }
  return null;
}
