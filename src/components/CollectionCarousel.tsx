import { useCallback, useMemo } from 'react';
import { View, useWindowDimensions } from 'react-native';
import Animated from 'react-native-reanimated';

import { CollectionCard } from '@/components/CollectionCard';
import { PageDots } from '@/components/PageDots';
import { padForLoop, useAutoCarousel } from '@/hooks/useAutoCarousel';
import type { Collection } from '@/hooks/useCollections';
import { COLLECTION_ASPECT } from '@/components/CollectionCard';
import { SPACE } from '@/theme/tokens';

/**
 * The collections row — second instance of the same carousel engine as the
 * hero, so the loop, the RTL handling and the UI-thread advance are shared
 * rather than reimplemented.
 *
 * The dwell is deliberately NOT the hero's. Two carousels on one screen ticking
 * at the same interval advance in lockstep, which stops reading as two
 * independent things and starts reading as a glitch. 6.4s against the hero's
 * 5s means they drift apart immediately and only realign every 32 seconds.
 */
const DWELL_MS = 6400;

export interface CollectionCarouselProps {
  collections: Collection[];
  onOpen: (collection: Collection) => void;
}

export function CollectionCarousel({ collections, onOpen }: CollectionCarouselProps) {
  const { width: screenWidth } = useWindowDimensions();

  const cardWidth = screenWidth - SPACE.edge * 2;
  const stride = cardWidth + SPACE.md;

  const carousel = useAutoCarousel({
    count: collections.length,
    stride,
    dwellMs: DWELL_MS,
  });

  const data = useMemo(
    () => (carousel.loops ? padForLoop(collections) : collections),
    [collections, carousel.loops],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Collection; index: number }) => (
      <CollectionCard
        collection={item}
        width={cardWidth}
        featured={index === 0}
        onPress={onOpen}
      />
    ),
    [cardWidth, onOpen],
  );

  if (collections.length === 0) return null;

  return (
    <View style={{ gap: SPACE.md }}>
      <Animated.FlatList
        ref={carousel.setListRef}
        data={data}
        horizontal
        renderItem={renderItem}
        // The trailing clone repeats a collection id, so the index has to be
        // part of the key or React sees duplicates.
        keyExtractor={(item, index) => `${index}-${item.id}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: SPACE.edge, gap: SPACE.md }}
        snapToInterval={stride}
        decelerationRate="fast"
        disableIntervalMomentum
        getItemLayout={carousel.getItemLayout}
        onScroll={carousel.scrollHandler}
        scrollEventThrottle={16}
        onMomentumScrollEnd={carousel.onInertMomentumEnd}
        // Each card holds three images, so the mount window is what keeps the
        // budget: one viewport either side → at most 9 stills alive.
        //
        // TWO at first paint, not one. With one, the neighbouring card is not
        // mounted and the edge peek disappears — the row would sit flush while
        // the hero directly above it peeks, which reads as a mistake rather
        // than a choice. Costs 6 images at first paint against the 3 the hero
        // needs, still comfortably inside the 9 cap.
        windowSize={3}
        initialNumToRender={2}
        maxToRenderPerBatch={1}
      />

      <PageDots
        count={collections.length}
        progress={carousel.progress}
        inertIndex={carousel.inertIndex}
        inert={carousel.inert}
      />
    </View>
  );
}

/** Height the row occupies, for callers that need to reserve space. */
export function collectionCardHeight(screenWidth: number): number {
  return Math.round((screenWidth - SPACE.edge * 2) / COLLECTION_ASPECT);
}
