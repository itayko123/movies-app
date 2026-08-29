import { useCallback, useMemo, useRef } from 'react';
import { View, useWindowDimensions } from 'react-native';
import Animated from 'react-native-reanimated';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { PageDots } from '@/components/PageDots';
import { PressableScale } from '@/components/PressableScale';
import { padForLoop, useAutoCarousel } from '@/hooks/useAutoCarousel';
import { imageUrl, type MediaDraft } from '@/lib/tmdb';
import { setHeroSource } from '@/lib/heroHandoff';
import { useT } from '@/i18n';
import { C, R, SHADOW, SPACE } from '@/theme/tokens';

/**
 * The featured strip at the top of Discover: wide backdrops, one page at a
 * time, advancing on their own.
 *
 * Geometry is measured off the reference: the card spans the screen minus one
 * edge inset on each side, which leaves the NEXT card peeking by a few px at
 * the trailing edge. That sliver is doing real work — it is the difference
 * between reading as a carousel and reading as a static banner — and it is
 * also why this is a FlatList rather than a native pager, whose pages are
 * full-width by construction.
 *
 * Cards are backdrops, not posters. A 2:3 poster at this width would eat half
 * the screen before the first shelf; the 16:9 crop is what lets a hero sit
 * above the fold with content still visible beneath it.
 */

/** Reference ratio, measured off the screenshot (662 × 385 device px). */
const ASPECT = 1.72;

/** More than this and the dots stop being countable at a glance. */
const MAX_CARDS = 5;

export interface HeroCarouselProps {
  items: MediaDraft[];
  onOpen: (item: MediaDraft) => void;
}

export function HeroCarousel({ items, onOpen }: HeroCarouselProps) {
  const { width: screenWidth } = useWindowDimensions();

  const cardWidth = screenWidth - SPACE.edge * 2;
  const cardHeight = Math.round(cardWidth / ASPECT);
  const stride = cardWidth + SPACE.md;

  // Only titles that actually have backdrop art — a hero card falling back to
  // a poster or a placeholder would break the row's rhythm.
  const cards = useMemo(
    () => items.filter((item) => Boolean(item.backdrop_path)).slice(0, MAX_CARDS),
    [items],
  );

  const carousel = useAutoCarousel({ count: cards.length, stride });

  /** Carries one clone of the first card at the END — see useAutoCarousel. */
  const data = useMemo(() => (carousel.loops ? padForLoop(cards) : cards), [cards, carousel.loops]);

  const renderItem = useCallback(
    ({ item }: { item: MediaDraft }) => (
      <HeroCard item={item} width={cardWidth} height={cardHeight} onPress={onOpen} />
    ),
    [cardWidth, cardHeight, onOpen],
  );

  if (cards.length === 0) return null;

  return (
    <View style={{ gap: SPACE.md }}>
      <Animated.FlatList
        ref={carousel.setListRef}
        data={data}
        horizontal
        renderItem={renderItem}
        // Clones share a tmdb id with their twin, so the index has to be part
        // of the key or React sees duplicates.
        keyExtractor={(item, index) => `${index}-${item.media_type}-${item.tmdb_id}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: SPACE.edge, gap: SPACE.md }}
        snapToInterval={stride}
        decelerationRate="fast"
        disableIntervalMomentum
        // Mandatory: scrollToIndex needs layout without having to measure.
        getItemLayout={carousel.getItemLayout}
        onScroll={carousel.scrollHandler}
        scrollEventThrottle={16}
        onMomentumScrollEnd={carousel.onInertMomentumEnd}
        // The ±1 mount window, using FlatList's own virtualisation rather than
        // hand-rolled index math: one viewport ahead and behind, so at most
        // three backdrops are ever decoded at once.
        windowSize={3}
        initialNumToRender={2}
        maxToRenderPerBatch={2}
      />

      <PageDots
        count={cards.length}
        progress={carousel.progress}
        inertIndex={carousel.inertIndex}
        inert={carousel.inert}
      />
    </View>
  );
}

function HeroCard({
  item,
  width,
  height,
  onPress,
}: {
  item: MediaDraft;
  width: number;
  height: number;
  onPress: (item: MediaDraft) => void;
}) {
  const t = useT();
  const frameRef = useRef<View>(null);
  const backdrop = imageUrl(item.backdrop_path, 'w780');

  /**
   * Measures the card so the detail screen can fly its hero in from exactly
   * here. Same contract as the poster tiles: if measuring fails the push still
   * happens, because a tap that silently does nothing is far worse than a
   * missing animation.
   */
  const open = useCallback(() => {
    const node = frameRef.current;
    if (!node) {
      onPress(item);
      return;
    }
    node.measureInWindow((x, y, w, h) => {
      if (w > 0 && h > 0) setHeroSource({ x, y, width: w, height: h });
      onPress(item);
    });
  }, [item, onPress]);

  return (
    <PressableScale
      onPress={open}
      haptic="light"
      activeScale={0.97}
      accessibilityRole="button"
      accessibilityLabel={item.title}
      style={{ width }}
    >
      <View
        ref={frameRef}
        style={{
          width,
          height,
          borderRadius: R.hero,
          overflow: 'hidden',
          backgroundColor: C.surface,
          ...SHADOW.card,
        }}
      >
        {backdrop && (
          <Image
            source={{ uri: backdrop }}
            style={{ width, height }}
            contentFit="cover"
            transition={260}
            cachePolicy="memory-disk"
            recyclingKey={item.backdrop_path ?? undefined}
          />
        )}

        {/* Scrim. Tall and weighted to the bottom so the title stays legible
            over a bright frame without dimming the whole image. */}
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.86)']}
          locations={[0.35, 0.62, 1]}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: height * 0.72 }}
        />

        <View
          style={{
            position: 'absolute',
            bottom: 0,
            start: 0,
            end: 0,
            padding: SPACE.lg,
            gap: 6,
          }}
        >
          <AppText variant="title" numberOfLines={2} className="text-white">
            {item.title}
          </AppText>

          <View className="flex-row items-center" style={{ gap: SPACE.sm }}>
            <AppText variant="caption" className="text-white/80">
              {item.media_type === 'tv' ? t('deck.series') : t('deck.movie')}
            </AppText>

            {item.release_year != null && (
              <AppText variant="caption" className="text-white/80">
                {item.release_year}
              </AppText>
            )}

            {item.vote_average != null && item.vote_average > 0 && (
              <View className="flex-row items-center" style={{ gap: 4 }}>
                <Ionicons name="star" size={11} color={C.accent} />
                <AppText variant="caption" className="text-white/80">
                  {item.vote_average.toFixed(1)}
                </AppText>
              </View>
            )}
          </View>
        </View>
      </View>
    </PressableScale>
  );
}
