import { View } from 'react-native';
import { AppText } from '@/components/AppText';

/**
 * Web mock for the ads layer.
 *
 * This file must NEVER import `react-native-google-mobile-ads` — the package
 * reaches for `react-native/Libraries/Utilities/codegenNativeComponent`,
 * which throws on web the moment it is imported. Metro's platform resolution
 * picks this file for `--web`, so the native SDK never enters the web bundle.
 * The exported surface is identical to ads.native.tsx.
 */

export const AD_INTERVAL = 8;

export function adsSupported(): boolean {
  return false;
}

/** Kept for API parity with the native module. */
export const AD_UNAVAILABLE_REASON = 'web';

export async function initAds(): Promise<void> {
  // No ads on web — UI-testing surface only.
}

export interface DeckAdBannerProps {
  onFailed: () => void;
}

/** Layout-faithful stand-in so the deck's ad rhythm is testable on web. */
export function DeckAdBanner(_props: DeckAdBannerProps) {
  return (
    <View className="w-[300px] h-[250px] rounded-2xl bg-card items-center justify-center">
      <AppText variant="caption" className="text-center px-6">
        Ad placeholder — ads render in native builds only
      </AppText>
    </View>
  );
}
