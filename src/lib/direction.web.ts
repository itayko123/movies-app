import { I18nManager } from 'react-native';
import type { Locale } from '@/state/store';

/**
 * Applies layout direction on the WEB.
 *
 * ── The bug this fixes ─────────────────────────────────────────────────────
 * `I18nManager.forceRTL(true)` is the whole story on native — it flips the
 * layout pass for every view. Under react-native-web it does much less: it
 * sets an internal flag and NOTHING touches the document. Verified live with
 * the app fully translated: every string rendered in Hebrew while
 * `document.documentElement` still had `lang="en"`, no `dir` attribute, and a
 * computed `direction: ltr`.
 *
 * That is not a cosmetic difference. In an LTR document the browser's bidi
 * algorithm puts Hebrew punctuation on the wrong side, text aligns left, and
 * react-native-web's logical properties (`margin-inline-start`,
 * `inset-inline-start` — what NativeWind's `ms-`/`start-` classes compile to)
 * resolve against `direction`, so every mirrored layout stays unmirrored.
 *
 * Setting `dir` on the root element is what actually flips all three at once.
 * `I18nManager` is still updated so any code branching on `isRTL` — notably
 * the swipe physics sign in SwipeCard — agrees with what is on screen.
 */
export function applyLayoutDirection(locale: Locale): boolean {
  const rtl = locale === 'he';

  I18nManager.allowRTL(true);
  I18nManager.forceRTL(rtl);

  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('dir', rtl ? 'rtl' : 'ltr');
    document.documentElement.setAttribute('lang', locale);
  }

  // The browser re-lays-out from the `dir` attribute immediately, so unlike
  // native there is never a reload to prompt for.
  return false;
}
