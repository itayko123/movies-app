import { useCallback } from 'react';
import { GENRE_CATALOG } from '@/lib/tmdb';
import { useAppStore, type Locale } from '@/state/store';

/**
 * Display names for genres.
 *
 * ── Why this is separate from the main dictionary ──────────────────────────
 * A genre's English name is its IDENTITY throughout the app: it keys
 * `GENRE_CATALOG`, it keys `genreWeights` in the persisted store, and it is
 * what gets matched against TMDB. It must never change with the UI language or
 * every taste weight would orphan itself the moment someone switched to
 * Hebrew.
 *
 * So the canonical name stays English forever and is translated only at the
 * point of RENDER. That is the bug this file fixes: Hebrew users saw a Hebrew
 * interface with sixteen English genre tiles in the middle of it, because the
 * onboarding grid rendered the catalogue keys directly.
 *
 * Anything that shows a genre to a human goes through `genreLabel`. Anything
 * that stores, compares or queries one uses the raw English key.
 */

type GenreName = keyof typeof GENRE_CATALOG;

const HEBREW: Record<GenreName, string> = {
  Action: 'אקשן',
  Adventure: 'הרפתקאות',
  Animation: 'אנימציה',
  Comedy: 'קומדיה',
  Crime: 'פשע',
  Documentary: 'תיעודי',
  Drama: 'דרמה',
  Family: 'משפחה',
  Fantasy: 'פנטזיה',
  History: 'היסטוריה',
  Horror: 'אימה',
  'Kids & Youth': 'ילדים ונוער',
  Music: 'מוזיקה',
  Mystery: 'מסתורין',
  Reality: 'ריאליטי',
  Romance: 'רומנטיקה',
  'Science Fiction': 'מדע בדיוני',
  Thriller: 'מותחן',
  War: 'מלחמה',
  Western: 'מערבון',
};

/**
 * Human-readable genre name in the given language.
 *
 * Unknown names pass through unchanged rather than throwing: TMDB's detail
 * endpoint returns genres outside our curated catalogue ("TV Movie"), and a
 * missing translation should degrade to the English word, not to a crash or an
 * empty label.
 */
export function genreLabel(genre: string, locale: Locale): string {
  if (locale !== 'he') return genre;
  return HEBREW[genre as GenreName] ?? genre;
}

/** Joins several genre names with a locale-appropriate separator. */
export function genreList(genres: string[], locale: Locale, separator = ' & '): string {
  return genres.map((genre) => genreLabel(genre, locale)).join(separator);
}

/** Locale-bound genre translator — re-renders on language switch. */
export function useGenreLabel(): (genre: string) => string {
  const locale = useAppStore((s) => s.locale);
  return useCallback((genre: string) => genreLabel(genre, locale), [locale]);
}
