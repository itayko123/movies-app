import { useCallback } from 'react';
import { FlatList, I18nManager, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { PosterTile, TILE, TILE_EDGE, TILE_GAP } from '@/components/PosterTile';
import { PressableScale } from '@/components/PressableScale';
import { Skeleton } from '@/components/Skeleton';
import { fetchDiscover, type MediaDraft } from '@/lib/tmdb';
import { useAppStore } from '@/state/store';
import { useT } from '@/i18n';
import { C, SPACE } from '@/theme/tokens';

/**
 * Everything by one person.
 *
 * ── Movies only, by construction ───────────────────────────────────────────
 * `/discover/tv` accepts `with_cast` and `with_crew` and then SILENTLY IGNORES
 * them, returning the unfiltered catalogue — see `supportsPeopleFilter` in
 * tmdb.ts. A TV section here would therefore be a lie dressed as
 * personalisation, so this screen is film only.
 *
 * ── The heading is deliberately vague ──────────────────────────────────────
 * TMDB has no "directed by" filter; `with_crew` matches ANY crew credit, so a
 * director page legitimately returns films they produced or wrote. The title is
 * "More from {name}", which is true of everything the query can return —
 * "Directed by" would not be.
 */
export default function PersonScreen() {
  const t = useT();
  const router = useRouter();
  const locale = useAppStore((s) => s.locale);
  const { id, name, role } = useLocalSearchParams<{
    id: string;
    name?: string;
    role?: string;
  }>();

  const personId = Number.parseInt(id ?? '', 10);
  const isDirector = role === 'director';

  const query = useQuery<MediaDraft[]>({
    queryKey: ['person-titles', personId, role, locale],
    enabled: Number.isFinite(personId),
    staleTime: 30 * 60 * 1000,
    queryFn: () =>
      fetchDiscover('movie', {
        page: 1,
        locale,
        ...(isDirector ? { crewIds: [personId] } : { castIds: [personId] }),
        sortBy: 'vote_count.desc',
        minVotes: 50,
      }),
  });

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

  const heading = name
    ? t(isDirector ? 'forYou.fromDirector' : 'forYou.withActor', { name })
    : '';

  const titles = query.data ?? [];

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
          {heading}
        </AppText>
      </View>

      {query.isLoading ? (
        <View
          className="flex-row flex-wrap justify-center"
          style={{ paddingHorizontal: TILE_EDGE, gap: TILE_GAP }}
        >
          {[0, 1, 2, 3].map((index) => (
            <Skeleton
              key={index}
              className="rounded-2xl"
              style={{ width: TILE.width, height: TILE.height }}
              delay={index * 70}
            />
          ))}
        </View>
      ) : titles.length === 0 ? (
        <View className="flex-1 items-center justify-center px-10">
          <AppText variant="body" className="text-center">
            {query.isError ? t('common.error') : t('discover.noTitles')}
          </AppText>
        </View>
      ) : (
        <FlatList
          data={titles}
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
