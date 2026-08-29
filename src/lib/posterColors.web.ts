/**
 * Poster colour extraction for web, via canvas.
 *
 * This exists because the previous code assumed extraction was impossible in a
 * browser — the comment claimed image.tmdb.org sends no CORS header. It does:
 *
 *   Access-Control-Allow-Origin: *
 *   Access-Control-Expose-Headers: *
 *
 * So a `crossOrigin="anonymous"` image can be drawn to a canvas and read back
 * without tainting it, and the dynamic palette works in the browser exactly as
 * it does in a native dev build.
 */

export interface ExtractedColors {
  primary: string;
  secondary: string;
}

/** Downscale target. 32×48 keeps the 2:3 poster ratio and ~1,500 samples. */
const SAMPLE_W = 32;
const SAMPLE_H = 48;

/**
 * Cache-partition marker appended to the extraction URL.
 *
 * Without it extraction silently fails on every poster the UI has already
 * shown. `expo-image` requests posters WITHOUT `crossOrigin`, so the browser
 * stores an opaque, non-CORS response; a later `crossOrigin="anonymous"`
 * request for the same URL reuses that cached entry, finds no usable CORS
 * headers on it, and rejects the load. Verified live: identical URL loads
 * plain, fails with crossOrigin, and succeeds again the moment the URL differs.
 *
 * A FIXED marker (not a random cache-buster) keeps the CORS variant itself
 * cacheable, so each poster is fetched at most once for extraction.
 */
const CORS_VARIANT = 'cors=1';

function corsUrl(url: string): string {
  return url.includes('?') ? `${url}&${CORS_VARIANT}` : `${url}?${CORS_VARIANT}`;
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** HSV value + saturation, used to reject washed-out and near-black pixels. */
function saturationValue(r: number, g: number, b: number): { s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return { s: max === 0 ? 0 : (max - min) / max, v: max / 255 };
}

export async function extractPosterColors(url: string): Promise<ExtractedColors | null> {
  if (typeof document === 'undefined') return null;

  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    // Required for a readable canvas; TMDB permits it.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = corsUrl(url);
  });
  if (!image) return null;

  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(image, 0, 0, SAMPLE_W, SAMPLE_H);

  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
  } catch {
    // Canvas tainted (should not happen with TMDB, but never throw for a theme).
    return null;
  }

  /**
   * Bucket into a 5-bit-per-channel histogram.
   *
   * Exact RGB values almost never repeat in a photograph, so counting raw
   * colours finds no dominant one. Quantising to 32 levels per channel groups
   * perceptually-similar pixels while still separating distinct hues.
   */
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const alpha = pixels[i + 3]!;
    if (alpha < 200) continue;

    const { s, v } = saturationValue(r, g, b);
    // Posters are largely dark backgrounds and white text; both make a dull
    // theme. Keep pixels with actual colour in them.
    if (v < 0.15 || v > 0.95) continue;
    if (s < 0.2) continue;

    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  if (buckets.size === 0) return null;

  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count);
  const average = (bucket: (typeof ranked)[number]) =>
    toHex(
      Math.round(bucket.r / bucket.count),
      Math.round(bucket.g / bucket.count),
      Math.round(bucket.b / bucket.count),
    );

  const primary = average(ranked[0]!);
  // Second-most-common bucket, or the dominant one again if the art is
  // essentially monochrome.
  const secondary = average(ranked[1] ?? ranked[0]!);

  return { primary, secondary };
}
