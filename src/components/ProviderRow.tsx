import { View } from 'react-native';
import { Image } from 'expo-image';
import { AppText } from '@/components/AppText';
import { imageUrl, type StreamingProvider } from '@/lib/tmdb';

export interface ProviderRowProps {
  label: string;
  providers: StreamingProvider[];
}

/**
 * One availability tier (Stream / Rent / Buy) with provider logos.
 * Logical flex layout only — mirrors cleanly under RTL.
 */
export function ProviderRow({ label, providers }: ProviderRowProps) {
  if (providers.length === 0) return null;

  return (
    <View className="flex-row items-center gap-3">
      <View className="w-16">
        <AppText variant="caption">{label}</AppText>
      </View>
      <View className="flex-row flex-wrap gap-2 flex-1">
        {providers.map((provider) => {
          const logo = imageUrl(provider.logo_path, 'w185');
          return (
            <View
              key={provider.provider_id}
              className="w-11 h-11 rounded-xl overflow-hidden bg-card"
              accessibilityLabel={provider.provider_name}
            >
              {logo && (
                <Image
                  source={{ uri: logo }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="cover"
                  transition={120}
                />
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}
