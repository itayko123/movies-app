import { useMemo, useState } from 'react';
import {
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { SaveSheet } from '@/components/SaveSheet';
import { ReviewSection } from '@/components/ReviewSection';
import { SectionHeader } from '@/components/SectionHeader';
import { HeroImage } from '@/components/HeroImage';
import { Skeleton } from '@/components/Skeleton';
import { ProviderRow } from '@/components/ProviderRow';
import { EngagementTimeline } from '@/components/EngagementTimeline';
import { ContrastScrim } from '@/theme/ThemeProvider';
import { C, R, SHADOW, SPACE } from '@/theme/tokens';
import { useMediaDetail, useMediaImages } from '@/hooks/useMediaDetail';
import { useEngagement } from '@/hooks/useEngagement';
import { usePosterPalette } from '@/hooks/usePosterPalette';
import { imageUrl, type MediaDetail } from '@/lib/tmdb';
import { useAppStore } from '@/state/store';
import { hapticHeavy, hapticMedium } from '@/lib/haptics';
import { useT } from '@/i18n';

import type { MediaItemRow, MediaType } from '@/types/media';

/** "2h 9m" / "48m" — compact enough for the meta strip. */
function formatRuntime(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

/** One cell of the three-up stat row. Fill-only — no stroke. */
function StatCard({ children }: { children: React.ReactNode }) {
  return (
    <View
      className="flex-1 items-center justify-center"
      style={{
        gap: SPACE.xs,
        paddingVertical: SPACE.lg,
        backgroundColor: C.surface,
        borderRadius: R.card,
      }}
    >
      {children}
    </View>
  );
}

export default function MediaDetailScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  const params = useLocalSearchParams<{
    id: string;
    type: string;
    mediaItemId?: string;
    title?: string;
    poster?: string;
  }>();

  const tmdbId = Number.parseInt(params.id ?? '0', 10);
  const mediaType: MediaType = params.type === 'tv' ? 'tv' : 'movie';
  const mediaItemId = params.mediaItemId ?? null;

  const detail = useMediaDetail(tmdbId, mediaType);
  const images = useMediaImages(tmdbId, mediaType);
  const engagement = useEngagement(mediaType === 'tv' ? mediaItemId : null);

  const [overviewExpanded, setOverviewExpanded] = useState(false);
  const [gallerySegment, setGallerySegment] = useState<'posters' | 'backdrops'>('posters');

  // High-res art belongs ONLY here: w780 hero, original full-bleed poster
  // fallback. The deck stays on w500 to protect low-end devices.
  const heroUrl = useMemo(() => {
    const backdrop = imageUrl(detail.data?.backdrop_path, 'w780');
    if (backdrop) return backdrop;
    const fullPoster = imageUrl(detail.data?.poster_path ?? params.poster, 'original');
    return fullPoster;
  }, [detail.data, params.poster]);

  usePosterPalette(heroUrl);

  /**
   * Library membership + writes.
   *
   * The old CTA here called the `apply_swipe` RPC — a function that does not
   * exist in the live project (REST probe: 404 PGRST202), so the button had
   * never actually saved anything. It now goes through the same store path as
   * a real swipe: instant local write, debounced cloud sync, taste queue.
   */
  const library = useAppStore((s) => s.library);
  const recordSwipe = useAppStore((s) => s.recordSwipe);
  const [saveSheetOpen, setSaveSheetOpen] = useState(false);

  const membership = useMemo(() => {
    for (const entry of Object.values(library)) {
      if (entry.item.tmdb_id === tmdbId && entry.item.media_type === mediaType) return entry;
    }
    return null;
  }, [library, tmdbId, mediaType]);

  const isWatchlisted = membership?.direction === 'superlike';
  const isWatched = membership?.direction === 'seen';

  const buildRow = (): MediaItemRow => ({
    // Reuse the id the library already knows this title by, so a save from
    // this screen updates the existing entry instead of duplicating it.
    id: membership?.item.id ?? mediaItemId ?? `mock-${mediaType}-${tmdbId}`,
    tmdb_id: tmdbId,
    media_type: mediaType,
    title: detail.data?.title ?? params.title ?? '',
    original_title: null,
    overview: detail.data?.overview ?? null,
    poster_path: detail.data?.poster_path ?? params.poster ?? null,
    backdrop_path: detail.data?.backdrop_path ?? null,
    // `genre_keys`, NOT `genres`. The latter is what this screen DISPLAYS and
    // is localised — under he-IL it is Hebrew. Writing that into the library
    // put keys like "אקשן" into genreWeights beside "Action": never matched by
    // GENRE_CATALOG, never sent to with_genres, and counted as a separate
    // genre by selectGenreStats, so one taste signal was being split in two.
    // Entries saved from the DECK were always canonical (toDraft maps ids);
    // only this screen's path drifted. See MediaDetail.genre_keys in tmdb.ts.
    genres: detail.data?.genre_keys ?? membership?.item.genres ?? [],
    runtime_minutes: detail.data?.runtime_minutes ?? null,
    release_year: detail.data?.release_year ?? null,
    vote_average: detail.data?.vote_average ?? null,
    popularity: null,
    origin_country: [],
  });

  const markWatchlisted = () => {
    if (isWatchlisted) return;
    hapticHeavy();
    recordSwipe(buildRow(), 'superlike');
  };

  const markWatched = () => {
    if (isWatched) return;
    hapticMedium();
    recordSwipe(buildRow(), 'seen');
  };

  const title = detail.data?.title ?? params.title ?? '';
  const heroHeight = height * 0.5;
  const runtime = formatRuntime(detail.data?.runtime_minutes);
  const score = detail.data?.vote_average ?? null;
  const votes = detail.data?.vote_count ?? null;

  const galleryPaths =
    (gallerySegment === 'posters' ? images.data?.posters : images.data?.backdrops) ?? [];

  /** Height the sticky bar occupies, so content can clear it. */
  const barHeight = insets.bottom + 92;

  return (
    <View className="flex-1 bg-app">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: barHeight + SPACE.section }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero. Reanimated 4 removed sharedTransitionTag, so the handoff is
            done by hand — HeroImage flies in from the poster's measured
            on-screen rectangle. See src/lib/heroHandoff.ts. */}
        <HeroImage uri={heroUrl} height={heroHeight}>
          <>
            <ContrastScrim intense />

            <View
              className="absolute bottom-0 start-0 end-0"
              style={{ padding: SPACE.edge, paddingBottom: SPACE.xxl }}
            >
              <AppText variant="hero" numberOfLines={3} className="text-white">
                {title}
              </AppText>
              {detail.data && detail.data.genres.length > 0 && (
                <AppText
                  variant="bodyStrong"
                  numberOfLines={1}
                  className="text-txt-secondary"
                  style={{ marginTop: SPACE.sm }}
                >
                  {detail.data.genres.slice(0, 3).join('  ·  ')}
                </AppText>
              )}

              {/* Icon meta strip — year · runtime · format. */}
              <View
                className="flex-row flex-wrap items-center"
                style={{ gap: SPACE.xl, marginTop: SPACE.lg }}
              >
                {detail.data?.release_year != null && (
                  <View className="flex-row items-center" style={{ gap: SPACE.sm }}>
                    <Ionicons name="calendar-outline" size={15} color={C.accent} />
                    <AppText variant="label" className="text-white">
                      {detail.data.release_year}
                    </AppText>
                  </View>
                )}
                {runtime != null && (
                  <View className="flex-row items-center" style={{ gap: SPACE.sm }}>
                    <Ionicons name="time-outline" size={15} color={C.accent} />
                    <AppText variant="label" className="text-white">
                      {runtime}
                    </AppText>
                  </View>
                )}
                {mediaType === 'tv' && detail.data?.number_of_seasons != null && (
                  <View className="flex-row items-center" style={{ gap: SPACE.sm }}>
                    <Ionicons name="albums-outline" size={15} color={C.accent} />
                    <AppText variant="label" className="text-white">
                      {t('detail.seasons', { count: detail.data.number_of_seasons })}
                    </AppText>
                  </View>
                )}
              </View>
            </View>
          </>
        </HeroImage>

        <View style={{ paddingHorizontal: SPACE.edge, paddingTop: SPACE.xxl, gap: SPACE.section }}>
          {/* Ratings — three-up stat row. Only real data: TMDB is the one
              source the app licenses, so it gets score + votes, with runtime
              and year filling the row. */}
          <View style={{ gap: SPACE.lg }}>
            <SectionHeader icon="star" title={t('detail.ratings')} />
            <View className="flex-row" style={{ gap: SPACE.md }}>
              <StatCard>
                <View className="flex-row items-center" style={{ gap: SPACE.sm }}>
                  <Ionicons name="star" size={17} color={C.star} />
                  <AppText variant="subtitle">
                    {score != null && score > 0 ? score.toFixed(1) : '—'}
                  </AppText>
                </View>
                <AppText variant="caption">
                  {votes != null && votes > 0
                    ? t('detail.votes', {
                        count: votes >= 1000 ? `${(votes / 1000).toFixed(1)}K` : votes,
                      })
                    : 'TMDB'}
                </AppText>
              </StatCard>
              <StatCard>
                <AppText variant="subtitle">{runtime ?? '—'}</AppText>
                <AppText variant="caption">{t('detail.runtime')}</AppText>
              </StatCard>
              <StatCard>
                <AppText variant="subtitle">{detail.data?.release_year ?? '—'}</AppText>
                <AppText variant="caption">{t('detail.year')}</AppText>
              </StatCard>
            </View>
          </View>

          {/* Overview — collapsed to five lines with an accent "See all". */}
          <View style={{ gap: SPACE.lg }}>
            <SectionHeader icon="information" title={t('detail.overview')} />
            {detail.isLoading ? (
              <View style={{ gap: SPACE.sm }}>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" delay={80} />
                <Skeleton className="h-4 w-3/5" delay={160} />
              </View>
            ) : (
              <Pressable
                onPress={() => setOverviewExpanded((v) => !v)}
                accessibilityRole="button"
                disabled={(detail.data?.overview ?? '').length < 180}
              >
                <AppText variant="body" numberOfLines={overviewExpanded ? undefined : 5}>
                  {detail.data?.overview ?? ''}
                </AppText>
                {(detail.data?.overview ?? '').length >= 180 && (
                  <AppText
                    variant="bodyStrong"
                    className="text-brand"
                    style={{ marginTop: SPACE.sm }}
                  >
                    {overviewExpanded ? t('common.showLess') : t('common.seeAll')}
                  </AppText>
                )}
              </Pressable>
            )}
          </View>

          {/* When It Gets Good (TV only, when data exists) */}
          {mediaType === 'tv' && engagement.data?.peak && engagement.data.points.length >= 2 && (
            <EngagementTimeline
              points={engagement.data.points}
              peak={engagement.data.peak}
              accentColor={C.accent}
            />
          )}

          {/* Where to watch — geo-resolved via TMDB/JustWatch data */}
          <View style={{ gap: SPACE.lg }}>
            <SectionHeader icon="play" title={t('detail.whereToWatch')} />
            {detail.isLoading ? (
              <View className="flex-row" style={{ gap: SPACE.sm }}>
                <Skeleton className="w-11 h-11 rounded-xl" />
                <Skeleton className="w-11 h-11 rounded-xl" delay={80} />
                <Skeleton className="w-11 h-11 rounded-xl" delay={160} />
              </View>
            ) : detail.data &&
              (detail.data.providers.flatrate.length > 0 ||
                detail.data.providers.rent.length > 0 ||
                detail.data.providers.buy.length > 0) ? (
              <Pressable
                disabled={!detail.data.providers.link}
                onPress={() => {
                  const link = detail.data?.providers.link;
                  if (link) void Linking.openURL(link);
                }}
                style={{ gap: SPACE.md }}
              >
                <ProviderRow label={t('detail.stream')} providers={detail.data.providers.flatrate} />
                <ProviderRow label={t('detail.rent')} providers={detail.data.providers.rent} />
                <ProviderRow label={t('detail.buy')} providers={detail.data.providers.buy} />
              </Pressable>
            ) : (
              <AppText variant="body">{t('detail.notStreaming')}</AppText>
            )}
          </View>

          {/* Cast — borderless portrait cards, name bold, role beneath. */}
          {detail.data && detail.data.cast.length > 0 && (
            <View style={{ gap: SPACE.lg }}>
              <SectionHeader icon="person" title={t('detail.cast')} />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: SPACE.lg, paddingEnd: SPACE.edge }}
              >
                {detail.data.cast.map((member: MediaDetail['cast'][number]) => {
                  const headshot = imageUrl(member.profile_path, 'w185');
                  return (
                    <View key={member.id} style={{ width: 112, gap: SPACE.md }}>
                      <View
                        style={{
                          width: 112,
                          height: 142,
                          borderRadius: R.media,
                          overflow: 'hidden',
                          backgroundColor: C.surface,
                          ...SHADOW.card,
                        }}
                      >
                        {headshot ? (
                          <Image
                            source={{ uri: headshot }}
                            style={{ width: '100%', height: '100%' }}
                            contentFit="cover"
                            transition={120}
                          />
                        ) : (
                          <View className="flex-1 items-center justify-center">
                            <Ionicons name="person" size={32} color={C.textTertiary} />
                          </View>
                        )}
                      </View>
                      <View style={{ gap: 2 }}>
                        <AppText variant="bodyStrong" numberOfLines={2}>
                          {member.name}
                        </AppText>
                        {member.character ? (
                          <AppText variant="caption" numberOfLines={1}>
                            {member.character}
                          </AppText>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          )}

          {/* Images — every poster and backdrop TMDB has for this title, with
              a posters ⇄ backdrops toggle. */}
          {(images.data?.posters.length ?? 0) + (images.data?.backdrops.length ?? 0) > 0 && (
            <View style={{ gap: SPACE.lg }}>
              <SectionHeader icon="image" title={t('detail.images')} />
              <View className="flex-row" style={{ gap: SPACE.chip }}>
                {(['posters', 'backdrops'] as const).map((segment) => {
                  const active = gallerySegment === segment;
                  const count =
                    segment === 'posters'
                      ? images.data?.posters.length ?? 0
                      : images.data?.backdrops.length ?? 0;
                  if (count === 0) return null;
                  return (
                    <PressableScale
                      key={segment}
                      onPress={() => setGallerySegment(segment)}
                      haptic="light"
                      accessibilityRole="button"
                      style={{
                        borderRadius: R.pill,
                        paddingHorizontal: SPACE.lg,
                        paddingVertical: SPACE.md,
                        backgroundColor: active ? C.chipActive : C.chip,
                      }}
                    >
                      <AppText
                        variant="label"
                        className={active ? 'text-brand' : 'text-txt-secondary'}
                      >
                        {t(segment === 'posters' ? 'detail.posters' : 'detail.backdrops')} · {count}
                      </AppText>
                    </PressableScale>
                  );
                })}
              </View>
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={galleryPaths}
                keyExtractor={(path) => path}
                contentContainerStyle={{ gap: SPACE.md, paddingEnd: SPACE.edge }}
                renderItem={({ item: path }) => {
                  const isPoster = gallerySegment === 'posters';
                  const uri = imageUrl(path, isPoster ? 'w342' : 'w780');
                  return (
                    <View
                      style={{
                        width: isPoster ? 138 : 262,
                        height: isPoster ? 207 : 148,
                        borderRadius: R.media,
                        overflow: 'hidden',
                        backgroundColor: C.surface,
                        ...SHADOW.card,
                      }}
                    >
                      {uri && (
                        <Image
                          source={{ uri }}
                          style={{ width: '100%', height: '100%' }}
                          contentFit="cover"
                          transition={140}
                          recyclingKey={path}
                        />
                      )}
                    </View>
                  );
                }}
              />
            </View>
          )}

          {/* Production — logo + name, fill-only cards that wrap. */}
          {detail.data && detail.data.production.length > 0 && (
            <View style={{ gap: SPACE.lg }}>
              <SectionHeader icon="business" title={t('detail.production')} />
              <View className="flex-row flex-wrap" style={{ gap: SPACE.md }}>
                {detail.data.production.map((company) => {
                  const logo = imageUrl(company.logo_path, 'w185');
                  return (
                    <View
                      key={company.id}
                      className="flex-row items-center"
                      style={{
                        gap: SPACE.md,
                        paddingVertical: SPACE.md,
                        paddingHorizontal: SPACE.lg,
                        borderRadius: R.card,
                        backgroundColor: C.surface,
                        maxWidth: '100%',
                      }}
                    >
                      {logo ? (
                        <View
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 9,
                            overflow: 'hidden',
                            backgroundColor: '#FFFFFF',
                            padding: 3,
                          }}
                        >
                          <Image
                            source={{ uri: logo }}
                            style={{ width: '100%', height: '100%' }}
                            contentFit="contain"
                            transition={120}
                          />
                        </View>
                      ) : (
                        <Ionicons name="business" size={19} color={C.textTertiary} />
                      )}
                      <AppText variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
                        {company.name}
                      </AppText>
                    </View>
                  );
                })}
              </View>
            </View>
          )}

          {/* User reviews. Local-only for now — see ReviewSection. */}
          <ReviewSection mediaKey={`${mediaType}:${tmdbId}`} />

          {/* Keywords — fill-only chip cloud, generous padding and gaps. */}
          {detail.data && detail.data.keywords.length > 0 && (
            <View style={{ gap: SPACE.lg }}>
              <SectionHeader icon="pricetag" title={t('detail.keywords')} />
              <View className="flex-row flex-wrap" style={{ gap: SPACE.chip }}>
                {detail.data.keywords.map((keyword) => (
                  <View
                    key={keyword.id}
                    style={{
                      paddingHorizontal: SPACE.lg,
                      paddingVertical: SPACE.md,
                      borderRadius: R.pill,
                      backgroundColor: C.chip,
                    }}
                  >
                    <AppText variant="label" className="text-txt-secondary">
                      {keyword.name}
                    </AppText>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>
      </ScrollView>

      {/*
        Sticky action bar.

        Previously two pills floated free over the content, which read as
        detached — the specific complaint. They now live inside a single
        frosted-glass bar pinned to the bottom: real blur samples the artwork
        scrolling beneath it, and an upward shadow separates it from content
        without a stroke.
      */}
      <GlassView
        tone="bar"
        className="absolute start-0 end-0 bottom-0"
        style={{ paddingBottom: insets.bottom + SPACE.md }}
      >
        <View
          className="flex-row"
          style={{
            gap: SPACE.md,
            paddingHorizontal: SPACE.edge,
            paddingTop: SPACE.lg,
          }}
        >
          <PressableScale
            onPress={() => setSaveSheetOpen(true)}
            haptic="light"
            accessibilityRole="button"
            accessibilityLabel={t('save.title')}
            style={{
              width: 54,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: R.pill,
              paddingVertical: SPACE.lg,
              backgroundColor: C.surfaceRaised,
            }}
          >
            <Ionicons name="list" size={20} color={C.text} />
          </PressableScale>

          <PressableScale
            onPress={markWatched}
            haptic="light"
            accessibilityRole="button"
            accessibilityState={{ selected: isWatched }}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: SPACE.sm,
              borderRadius: R.pill,
              paddingVertical: SPACE.lg,
              backgroundColor: isWatched ? C.accentSoft : C.surfaceRaised,
            }}
          >
            <Ionicons
              name={isWatched ? 'checkmark-circle' : 'checkmark'}
              size={19}
              color={isWatched ? C.accent : C.text}
            />
            <AppText variant="bodyStrong" className={isWatched ? 'text-brand' : 'text-txt'}>
              {t('detail.watched')}
            </AppText>
          </PressableScale>

          <PressableScale
            onPress={markWatchlisted}
            haptic="medium"
            accessibilityRole="button"
            accessibilityState={{ selected: isWatchlisted }}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: SPACE.sm,
              borderRadius: R.pill,
              paddingVertical: SPACE.lg,
              backgroundColor: C.accent,
              ...SHADOW.accent,
            }}
          >
            <Ionicons name={isWatchlisted ? 'checkmark' : 'add'} size={19} color={C.onAccent} />
            <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
              {t('deck.watchlist')}
            </AppText>
          </PressableScale>
        </View>
      </GlassView>

      {saveSheetOpen && (
        <SaveSheet item={buildRow()} onClose={() => setSaveSheetOpen(false)} />
      )}

      {/* Back button — logical START so it mirrors under RTL. */}
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        className="absolute start-5 w-11 h-11 rounded-full overflow-hidden"
        style={{ top: insets.top + SPACE.sm }}
      >
        <GlassView tone="chip" className="flex-1 rounded-full items-center justify-center">
          <Ionicons name="chevron-back" size={22} color={C.accent} />
        </GlassView>
      </Pressable>

      {/* Keeps the hero readable under the status bar without a solid header. */}
      <LinearGradient
        colors={['rgba(0,0,0,0.72)', 'transparent']}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: insets.top + 64,
          pointerEvents: 'none',
        }}
      />
    </View>
  );
}
