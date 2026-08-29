import { I18nManager } from 'react-native';
import type { Locale } from '@/state/store';

/**
 * Applies layout direction on iOS and Android.
 *
 * Native has one real mechanism: `I18nManager.forceRTL` flips the direction
 * used by the layout pass for every view in the app. The catch is that views
 * already mounted are not re-laid-out, so switching language mid-session needs
 * an app restart to fully take effect.
 *
 * The boolean return says exactly that — "the direction you asked for is not
 * the direction currently on screen" — and the Profile screen uses it to offer
 * a reload instead of leaving the user in a half-mirrored UI.
 */
export function applyLayoutDirection(locale: Locale): boolean {
  const rtl = locale === 'he';

  I18nManager.allowRTL(true);
  I18nManager.forceRTL(rtl);

  return I18nManager.isRTL !== rtl;
}
