import { useCallback } from 'react';
import { en } from './en';
import { he } from './he';
import { useAppStore } from '@/state/store';
import { BRAND } from '@/theme/brand';

export type Locale = 'en' | 'he';
export type TranslationKey = keyof typeof en;
export type TranslateParams = Record<string, string | number>;

const dictionaries: Record<Locale, Record<TranslationKey, string>> = { en, he };

export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: TranslateParams,
): string {
  let value = dictionaries[locale][key] ?? en[key];
  // The product name is provisional, so it lives in ONE constant and is
  // interpolated into every string that mentions it. See src/theme/brand.ts.
  if (value.includes('{brand}')) {
    value = value.replaceAll('{brand}', BRAND[locale]);
  }
  if (params) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
  }
  return value;
}

export type Translator = (key: TranslationKey, params?: TranslateParams) => string;

/** Locale-bound translator hook — re-renders on language switch. */
export function useT(): Translator {
  const locale = useAppStore((s) => s.locale);
  return useCallback<Translator>(
    (key, params) => translate(locale, key, params),
    [locale],
  );
}
