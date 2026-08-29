import { Platform, View } from 'react-native';
import { AppText } from '@/components/AppText';
import { env } from '@/lib/env';
import { IS_EXPO_GO } from '@/lib/runtime';

/**
 * Native ads implementation (Android/iOS dev builds).
 *
 * `react-native-google-mobile-ads` ships C++/Java/Obj-C that Expo Go does not
 * contain, so every touch of the SDK is a lazy `require()` behind an Expo Go
 * guard — importing this module never crashes, and Expo Go renders a
 * placeholder instead of a live banner. Web never loads this file at all
 * (Metro resolves ads.web.tsx there).
 */


/** A free-tier user sees an ad card after every N media cards. */
export const AD_INTERVAL = 8;

/**
 * Ads are hard-disabled in development.
 *
 * The Google Mobile Ads SDK initialises native code that crashes when the
 * AdMob app IDs aren't provisioned for the current build, which is the normal
 * state of a dev client. `__DEV__` short-circuits every entry point below, so
 * the module is never even required — no initialisation, no banner, no crash.
 * Verify ads in a release/TestFlight build.
 */
export function adsSupported(): boolean {
  return !__DEV__ && !IS_EXPO_GO;
}

let initialized = false;

export async function initAds(): Promise<void> {
  // Never touch the native SDK in development — see adsSupported().
  if (!adsSupported() || initialized) return;
  try {
    const mobileAds = require('react-native-google-mobile-ads').default;
    await mobileAds().initialize();
    initialized = true;
  } catch (err) {
    if (__DEV__) console.warn('AdMob init failed:', err);
  }
}

/** Ad unit for the in-deck card. Only reached in release builds. */
function deckAdUnitId(): string {
  const { TestIds } = require('react-native-google-mobile-ads');
  const id =
    Platform.OS === 'ios'
      ? env.EXPO_PUBLIC_ADMOB_DECK_IOS
      : env.EXPO_PUBLIC_ADMOB_DECK_ANDROID;
  return id || TestIds.ADAPTIVE_BANNER;
}

function AdPlaceholder() {
  return (
    <View className="w-[300px] h-[250px] rounded-2xl bg-card items-center justify-center">
      <AppText variant="caption" className="text-center px-6">
        Ad slot — live ads render in release builds only
      </AppText>
    </View>
  );
}

export interface DeckAdBannerProps {
  /** Called when the ad fails to fill so the deck can move on. */
  onFailed: () => void;
}

export function DeckAdBanner({ onFailed }: DeckAdBannerProps) {
  if (!adsSupported()) return <AdPlaceholder />;

  const { BannerAd, BannerAdSize } = require('react-native-google-mobile-ads');
  return (
    <BannerAd
      unitId={deckAdUnitId()}
      size={BannerAdSize.MEDIUM_RECTANGLE}
      onAdFailedToLoad={onFailed}
      requestOptions={{ requestNonPersonalizedAdsOnly: true }}
    />
  );
}
