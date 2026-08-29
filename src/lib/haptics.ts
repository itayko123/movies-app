import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { safeFireAndForget } from '@/lib/safeNative';

/**
 * Central haptics vocabulary — every meaningful interaction routes through
 * here so the physical language stays consistent app-wide.
 *
 * Every call is wrapped: expo-haptics validates arguments synchronously and
 * throws a CodedError on unsupported hardware/runtimes, which would otherwise
 * escape as an unhandled rejection. Web has no Haptic Engine at all, so the
 * whole module short-circuits there.
 */

const SUPPORTED = Platform.OS === 'ios' || Platform.OS === 'android';

/** Crossing a swipe threshold, toggling a control. */
export function hapticSelection(): void {
  if (!SUPPORTED) return;
  safeFireAndForget('Haptics.selectionAsync', () => Haptics.selectionAsync());
}

/** Card grab / minor contact / button press. */
export function hapticLight(): void {
  if (!SUPPORTED) return;
  safeFireAndForget('Haptics.impactAsync(Light)', () =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  );
}

/** Committing a like/dislike swipe. */
export function hapticMedium(): void {
  if (!SUPPORTED) return;
  safeFireAndForget('Haptics.impactAsync(Medium)', () =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  );
}

/** Superlike / big moments. */
export function hapticHeavy(): void {
  if (!SUPPORTED) return;
  safeFireAndForget('Haptics.impactAsync(Heavy)', () =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy),
  );
}

/** Purchase complete, duo matched. */
export function hapticSuccess(): void {
  if (!SUPPORTED) return;
  safeFireAndForget('Haptics.notificationAsync(Success)', () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  );
}

/** Quota exhausted, errors. */
export function hapticWarning(): void {
  if (!SUPPORTED) return;
  safeFireAndForget('Haptics.notificationAsync(Warning)', () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  );
}
