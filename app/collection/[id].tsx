import { useCallback } from 'react';
import { FlatList, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { I18nManager } from 'react-native';

import { AppText } from '@/components/AppText';
import { PosterTile, TILE, TILE_EDGE, TILE_GAP } from '@/components/PosterTile';
import { PressableScale } from '@/components/PressableScale';
import { useCollections } from '@/hooks/useCollections';
import { useRecommendations } from '@/hooks/useRecommendations';
import type { MediaDraft } from '@/lib/tmdb';
import { useT } from '@/i18n';
import { C, SPACE } from '@/theme/tokens';

/**
 * Everything in one collection.
 *
 * Deliberately re-derives from `useCollections` rather than being handed the
 * list through route params: the shelves live in a react-query cache that is
 * already warm, so this costs no request, and a route that can be opened cold
 * (deep link, reload) still works. Route params would have meant serialising a
 * hundred titles into a URL.
 *
 * Without a destination the collection cards on Discover would be decoration —
 * this is what makes them a real affordance.
 */
export default function CollectionScreen() {
  const t = useT();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { rows } = useRecommendations();
  const collections = useCollections(rows);

  const collection = collections.find((entry) => entry.id === id);

  const openDetail = useCallback(
    (item: MediaDraft) => {
      router.push({
        pathname: '/media/[id]',
        params: {
          id: String(item.tmdb_id),
          type: item.media_type,
          title: item.title,
          poster: item.poster_path ?? '',
        },
      });
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: MediaDraft }) => (
      <PosterTile item={item} size={TILE} onPress={openDetail} />
    ),
    [openDetail],
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1 }}>
      <View
        className="flex-row items-center"
        style={{ paddingHorizontal: SPACE.edge, gap: SPACE.md, paddingBottom: SPACE.md }}
      >
        <PressableScale
          onPress={() => router.back()}
          haptic="light"
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <Ionicons
            name="arrow-back"
            size={22}
            color={C.text}
            // Ionicons does not mirror direction-carrying glyphs on its own.
            style={I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined}
          />
        </PressableScale>

        <AppText variant="title" className="flex-1" numberOfLines={2}>
          {collection?.title ?? ''}
        </AppText>
      </View>

      {collection == null ? (
        // Reachable on a cold deep link before the shelves have loaded, or if
        // the filter that produced this collection has since changed.
        <View className="flex-1 items-center justify-center px-10">
          <AppText variant="body" className="text-center">
            {t('common.error')}
          </AppText>
        </View>
      ) : (
        <FlatList
          data={collection.items}
          keyExtractor={(item) => `${item.media_type}-${item.tmdb_id}`}
          renderItem={renderItem}
          numColumns={2}
          columnWrapperStyle={{ gap: TILE_GAP, justifyContent: 'center' }}
          contentContainerStyle={{
            paddingHorizontal: TILE_EDGE,
            paddingBottom: 120,
            gap: SPACE.lg,
          }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={8}
          windowSize={5}
        />
      )}
    </SafeAreaView>
  );
}
