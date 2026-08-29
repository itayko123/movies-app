/**
 * "Cinematic Midnight" — design tokens.
 *
 * COLOUR is specified by the product owner (OLED black canvas, electric-cyan
 * accent, translucent navy surfaces). GEOMETRY is measured from the Cineswipe
 * reference screenshots: generous section rhythm, tall touch rows, fill-only
 * chips, sheets that overlap live content.
 *
 * Two rules this file exists to enforce:
 *
 *  1. NO SOLID BORDERS. Separation comes from surface contrast, blur, and
 *     shadow. There is deliberately no `border` colour token — if you find
 *     yourself wanting one, raise the surface a step instead.
 *  2. SPACE IS A SCALE, not a guess. Every gap/padding in the app reads from
 *     SPACE so the rhythm stays consistent and can be tuned globally.
 *
 * tailwind.config.js mirrors the palette; scripts/check-tokens.js fails the
 * build if the two drift apart.
 */

export const C = {
  /** Root canvas. True black — OLED pixels off. */
  bg: '#000000',
  /** Barely-lifted canvas for large passive areas. */
  bgRaised: '#050505',

  /**
   * Surfaces. Navy-tinted rather than neutral grey: under a cyan accent a
   * grey surface reads as dirty, a navy one reads as deliberate.
   * `surface` is the opaque fallback; `surfaceGlass*` are what sits ON TOP of
   * a BlurView, so they must stay translucent or the blur is wasted.
   */
  surface: '#121826',
  surfaceRaised: '#1A2233',
  surfaceGlass: 'rgba(18,24,38,0.62)',
  surfaceGlassStrong: 'rgba(18,24,38,0.86)',
  /** Chip / segmented-control fill. Fill-only, never bordered. */
  chip: 'rgba(148,163,184,0.13)',
  chipActive: 'rgba(0,184,217,0.18)',

  /**
   * Primary accent: DEEP electric cyan.
   *
   * #00E5FF read as pastel against true black — at that lightness the hue
   * washes out and stops looking like neon. Dropped to #00B8D9: same hue
   * family, ~19% less luminance, so it reads as deep/electric while still
   * clearing contrast on black by a wide margin.
   */
  accent: '#00B8D9',
  accentDeep: '#0092A8',
  /** Accent washes for selected states. */
  accentSoft: 'rgba(0,184,217,0.16)',
  accentGlow: 'rgba(0,184,217,0.38)',
  /** Ink on a solid cyan fill — cyan is still a LIGHT colour, so ink is near-black. */
  onAccent: '#001016',
  /** Ink on WHITE surfaces — the vendor auth buttons must stay legible. */
  onLight: '#131316',

  /**
   * Secondary accent: violet. Reserved for PREMIUM and DUO affordances only —
   * the one place the app needs to say "this is special" without borrowing the
   * primary accent (which would erase the free/premium distinction) or the deck
   * greens (which mean "yes"). Never use it for ordinary CTAs.
   */
  secondary: '#A78BFA',
  secondarySoft: 'rgba(167,139,250,0.16)',

  /**
   * Amber, and it means exactly one thing: a streak that is ALIVE but not yet
   * hot. The flame runs dim slate (cold) → amber (going) → accent (7+ days),
   * so the middle state needs a colour that is neither "off" nor "achieved".
   * Not a general-purpose warning colour — nothing else should reach for it.
   */
  streak: '#FBBF24',

  text: '#FFFFFF',
  textSecondary: '#94A3B8',
  textTertiary: '#64748B',

  /**
   * Swipe semantics — REVERTED to the original Cineswipe reference family.
   *
   * The deck is the one place that does NOT use the app accent. In the first
   * reference the verdicts are a red thumbs-down and a green thumbs-up on dark
   * circles, with the watchlist bookmark green-on-olive. Tinting those cyan
   * made every control look the same and lost the instant red/green read that
   * makes a swipe deck legible at speed. Cyan stays the app accent everywhere
   * else; green/red mean "yes/no" and nothing else.
   */
  nope: '#E8503F',
  nopeSoft: 'rgba(232,80,63,0.16)',
  like: '#8BC53F',
  likeSoft: 'rgba(139,197,63,0.16)',
  /** Olive disc the reference pairs with its green bookmark glyph. */
  olive: '#3A4517',
  /** Watchlist: green glyph on the olive disc, per the reference. */
  super: '#8BC53F',
  superSoft: 'rgba(139,197,63,0.16)',
  seen: '#FBBF24',

  /** Ratings: cyan star on a dark scrim chip. */
  star: '#00B8D9',
  ratingChip: 'rgba(0,0,0,0.66)',

  /** Hairline separator for review lists — the ONE permitted line, and it is
   *  a divider between content, not a border around a box. */
  divider: 'rgba(148,163,184,0.14)',
} as const;

/**
 * Spacing scale. The previous design hard-coded 8/12/16 inline and the result
 * was described (accurately) as suffocating; these are deliberately larger.
 */
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  /** Vertical gap BETWEEN major sections. Measured ~26pt in the reference. */
  section: 32,
  /** Screen horizontal inset. */
  edge: 20,
  /** Interior padding of a card/sheet. */
  card: 20,
  /** Gap between sibling chips in a cloud. */
  chip: 10,
} as const;

export const R = {
  /** Chips, small controls. */
  chip: 14,
  /** Poster / media thumbnails. */
  media: 14,
  /** Standard cards. */
  card: 20,
  /** Large feature cards and the deck card. */
  hero: 26,
  /** Bottom sheets — top corners only. */
  sheet: 32,
  pill: 999,
} as const;

/**
 * Depth presets. RN 0.81 deprecates shadow* props; `boxShadow` works on the
 * New Architecture and on web, `elevation` remains the Android fallback.
 */
export const SHADOW = {
  card: { boxShadow: '0px 10px 30px rgba(0,0,0,0.55)', elevation: 8 },
  raised: { boxShadow: '0px 16px 40px rgba(0,0,0,0.65)', elevation: 14 },
  /** Sticky bars: shadow points UP, since the bar sits at the bottom. */
  bar: { boxShadow: '0px -8px 32px rgba(0,0,0,0.75)', elevation: 20 },
  /** Cyan bloom under a primary CTA. */
  accent: { boxShadow: '0px 8px 26px rgba(0,184,217,0.34)', elevation: 10 },
} as const;

/** Blur intensities, tuned per platform in GlassView. */
export const BLUR = {
  soft: 24,
  medium: 48,
  heavy: 72,
} as const;

/** Circular icon chip that leads every section header in the reference. */
export const SECTION_ICON = {
  size: 40,
  radius: 20,
} as const;
