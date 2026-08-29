import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { DeckAdBanner } from '@/lib/ads';
import { hapticSelection } from '@/lib/haptics';

export interface AdCardProps {
  label: string;
  onDismiss: () => void;
}

/**
 * Unobtrusive native ad interleaved into the free-tier deck. Card-shaped so
 * the deck rhythm is preserved; clearly labeled; dismissible.
 * Never rendered for premium users (gated by the caller against the
 * encrypted offline entitlement cache).
 */
export function AdCard({ label, onDismiss }: AdCardProps) {
  const [failed, setFailed] = useState(false);

  // If the ad fails to fill, don't hold the deck hostage.
  useEffect(() => {
    if (failed) onDismiss();
  }, [failed, onDismiss]);

  if (failed) return null;

  return (
    <View className="absolute items-center justify-center" style={{ top: 0, bottom: 0, left: 0, right: 0 }}>
      <GlassView className="rounded-hero w-full flex-1 items-center justify-center p-6">
        <View className="absolute top-4 start-4 bg-glass-strong rounded-full px-3 py-1">
          <AppText variant="caption" className="text-txt-secondary">
            {label}
          </AppText>
        </View>

        <Pressable
          onPress={() => {
            hapticSelection();
            onDismiss();
          }}
          accessibilityRole="button"
          className="absolute top-4 end-4 w-9 h-9 rounded-full bg-glass-strong items-center justify-center"
        >
          <Ionicons name="close" size={18} color="rgba(250,250,250,0.8)" />
        </Pressable>

        {/* Platform-resolved: real banner on native builds, layout-faithful
            placeholder on web and Expo Go (see src/lib/ads.*). */}
        <DeckAdBanner onFailed={() => setFailed(true)} />
      </GlassView>
    </View>
  );
}
