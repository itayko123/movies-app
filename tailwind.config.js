/** @type {import('tailwindcss').Config} */
// "Cinematic Midnight". Single source of truth for the palette lives in
// src/theme/tokens.ts. Metro can't require TS from here, so the values are
// mirrored; scripts/check-tokens.js fails the build if they drift.
//
// NOTE: there is intentionally NO border colour token. Separation in this
// design comes from surface contrast, blur and shadow — never from a stroke.
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  // Required by NativeWind on web; without it, setting the color scheme
  // throws "Cannot manually set color scheme, as dark mode is not enabled".
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        app: '#000000', // true black canvas
        'app-raised': '#050505',
        surface: '#121826', // navy-tinted, opaque fallback
        'surface-raised': '#1A2233',
        card: '#121826',
        elevated: '#1A2233',
        oled: '#000000',

        // Translucent layers — these sit ON a BlurView.
        glass: 'rgba(18,24,38,0.62)',
        'glass-strong': 'rgba(18,24,38,0.86)',
        chip: 'rgba(148,163,184,0.13)',
        'chip-active': 'rgba(0,184,217,0.18)',
        divider: 'rgba(148,163,184,0.14)',

        // brand == electric cyan.
        brand: {
          DEFAULT: '#00B8D9',
          soft: 'rgba(0,184,217,0.16)',
          deep: '#0092A8',
        },
        accent: '#00B8D9',
        // Premium / Duo only — see C.secondary in src/theme/tokens.ts.
        secondary: '#A78BFA',
        // Deck verdict colours are the reference's green/red family, NOT the
        // app accent — see the note on C.like in src/theme/tokens.ts.
        like: '#8BC53F',
        nope: '#E8503F',
        // Mid-state of the streak flame only — see C.streak in tokens.ts.
        streak: '#FBBF24',
        olive: '#3A4517',
        super: '#8BC53F',

        txt: {
          DEFAULT: '#FFFFFF',
          secondary: '#94A3B8',
          tertiary: '#64748B',
          onaccent: '#001016',
          // Ink for text sitting on WHITE surfaces (Google/Apple auth
          // buttons, light chips). Deleting this during the Midnight
          // migration is what made the Google button white-on-white.
          onlight: '#131316',
        },
      },
      fontFamily: {
        // Headlines / titles — bold, rounded, excellent Hebrew coverage.
        display: ['SecularOne_400Regular'],
        // Body copy / UI.
        sans: ['Rubik_400Regular'],
        'sans-medium': ['Rubik_500Medium'],
        'sans-semibold': ['Rubik_600SemiBold'],
        'sans-bold': ['Rubik_700Bold'],
        'sans-black': ['Rubik_800ExtraBold'],
      },
      borderRadius: {
        chip: '14px',
        media: '14px',
        card: '20px',
        hero: '26px',
        sheet: '32px',
      },
      spacing: {
        edge: '20px',
        card: '20px',
        section: '32px',
      },
    },
  },
  plugins: [],
};
