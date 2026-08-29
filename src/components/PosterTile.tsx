import { useCallback, useRef } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { imageUrl, type MediaDraft } from '@/lib/tmdb';
import { setHeroSource } from '@/lib/heroHandoff';
import { useT } from '@/i18n';
import { C } from '@/theme/tokens';

/**
 * Poster tiles are a FIXED pixel size, never a percentage or an aspect ratio.
 *
 * This is the bug that broke the screen on device. The tile used
 * `aspectRatio: 2/3` on the frame and `height: '100%'` on the image inside it.
 * A percentage height only resolves against a parent with a DEFINITE height —
 * an aspect-ratio-derived height is not definite at measure time, so Yoga
 * resolved it to `auto` and expo-image fell back to the poster's intrinsic
 * resolution: 342px-wide artwork rendering at full size and bleeding off the
 * screen. Web's CSS aspect-ratio resolves this differently, which is exactly
 * why it looked fine in the browser and broke in Expo Go.
 *
 * Explicit numbers remove the entire class of problem: nothing is inferred.
 *
 * Extracted from the Discover screen so the collection and person routes get
 * the fix and the hero handoff for free rather than growing their own tile.
 */
export const TILE = { width: 128, height: 192 } as const;
export const HERO_TILE = { width: 156, height: 234 } as const;
export const TILE_GAP = 12;
export const TILE_EDGE = 20;

export interface PosterTileProps {
  item: MediaDraft;
  size: { width: number; height: number };
  onPress: (item: MediaDraft) => void;
}

export function PosterTile({ item, size, onPress }: PosterTileProps) {
  const t = useT();
  const poster = imageUrl(item.poster_path, size.width > 140 ? 'w500' : 'w342');
  const frameRef = useRef<View>(null);

  /**
   * Measures the tile so the detail screen can fly its hero in from exactly
   * here. measureInWindow is async, so the push happens in the callback — but
   * it also happens unconditionally if measuring fails, because a tap that
   * silently does nothing is far worse than a missing animation.
   */
  const open = useCallback(() => {
    const node = frameRef.current;
    if (!node) {
      onPress(item);
      return;
    }
    node.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) setHeroSource({ x, y, width, height });
      onPress(item);
    });
  }, [item, onPress]);

  return (
    <PressableScale
      onPress={open}
      haptic="light"
      activeScale={0.94}
      accessibilityRole="button"
      accessibilityLabel={item.title}
      style={{ width: size.width }}
    >
      <View
        ref={frameRef}
        style={{
          width: size.width,
          height: size.height,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: C.surface,
          boxShadow: '0px 8px 20px rgba(0,0,0,0.45)',
          elevation: 6,
        }}
      >
        {poster && (
          <Image
            source={{ uri: poster }}
            // Explicit pixel dimensions — see the note on TILE above.
            style={{ width: size.width, height: size.height }}
            contentFit="cover"
            transition={180}
            cachePolicy="memory-disk"
            recyclingKey={`${item.media_type}-${item.tmdb_id}`}
          />
        )}

        {/* Keeps the rating chip legible over bright artwork. */}
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.75)']}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56 }}
        />

        {item.vote_average != null && item.vote_average > 0 && (
          <View
            className="absolute top-1.5 start-1.5 flex-row items-center gap-1 rounded-full px-2 py-1"
            style={{ backgroundColor: 'rgba(0,0,0,0.66)' }}
          >
            <Ionicons name="star" size={10} color={C.accent} />
            <AppText variant="caption" className="text-white">
              {item.vote_average.toFixed(1)}
            </AppText>
          </View>
        )}

        <View className="absolute bottom-1.5 start-1.5">
          <AppText variant="caption" className="text-white/85">
            {item.media_type === 'tv' ? t('deck.series') : t('deck.movie')}
          </AppText>
        </View>
      </View>

      <AppText
        variant="caption"
        numberOfLines={2}
        className="mt-1.5 text-txt"
        style={{ width: size.width }}
      >
        {item.title}
      </AppText>
    </PressableScale>
  );
}
