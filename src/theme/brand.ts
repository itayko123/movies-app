/**
 * The product name, in ONE place.
 *
 * The name is still provisional ("בינתיים, עד שנחשוב על שם"), so every visible
 * instance reads from here rather than being spelled out in each locale file.
 * Renaming the product later is a one-line edit to BRAND — not a sweep across
 * screens, legal copy, share messages and the paywall.
 *
 * Note this is the DISPLAY name only. The URL scheme (`cineswipe://`), the
 * Supabase project and the deep-link domain are deliberately NOT renamed: they
 * are registered identifiers, and changing them would break existing magic
 * links, OAuth redirects and any installed build.
 */
export const BRAND = {
  /** Hebrew display name — the primary, since the app is Hebrew-first. */
  he: 'תבחר לי סרט',
  /** English display name. */
  en: 'Pick My Movie',
} as const;

export type BrandLocale = keyof typeof BRAND;
