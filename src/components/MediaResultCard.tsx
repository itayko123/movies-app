import { View } from 'react-native';
import { Image } from 'expo-image';
import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { imageUrl } from '@/lib/tmdb';
import type { MoodResult } from '@/types/media';

export interface MediaResultCardProps {
  result: MoodResult;
  matchLabel: string;
  onPress: () => void;
}

/** Compact poster card used in mood-search carousels and duo results. */
export function MediaResultCard({ result, matchLabel, onPress }: MediaResultCardProps) {
  const poster = imageUrl(result.poster_path, 'w342');

  return (
    <PressableScale
      onPress={onPress}
      haptic="selection"
      activeScale={0.94}
      accessibilityRole="button"
      accessibilityLabel={result.title}
      style={{ width: 128 }}
    >
      <View className="w-32 h-48 rounded-2xl overflow-hidden bg-card">
        {poster && (
          <Image
            source={{ uri: poster }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={150}
            recyclingKey={result.id}
          />
        )}
        <View className="absolute top-1.5 start-1.5 bg-black/70 rounded-full px-2 py-0.5">
          <AppText variant="caption" className="text-accent">
            {matchLabel}
          </AppText>
        </View>
      </View>
      <AppText variant="caption" numberOfLines={2} className="mt-1.5 text-txt-secondary">
        {result.title}
        {result.release_year != null ? ` · ${result.release_year}` : ''}
      </AppText>
    </PressableScale>
  );
}
