import { View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { LogoMark } from '@/components/AnimatedLogo';
import { PressableScale } from '@/components/PressableScale';
import { STRIP_TILES, type Collection } from '@/hooks/useCollections';
import { imageUrl } from '@/lib/tmdb';
import { BRAND } from '@/theme/brand';
import { useT } from '@/i18n';
import { C, R, SHADOW, SPACE } from '@/theme/tokens';

/**
 * One "Cinelist" card: a short, wide banner whose background is a filmstrip of
 * stills from the titles inside it.
 *
 * ── The seam is the whole idea ─────────────────────────────────────────────
 * The tiles are butted together with NO gap and no individual corners. That is
 * what makes the strip read as one object — a strip of film — rather than as a
 * row of thumbnails that happen to be adjacent. Rounding is applied once, to
 * the card, and the tiles are clipped by it.
 *
 * ── Image budget ───────────────────────────────────────────────────────────
 * Three tiles per card, four cards, and the carousel only mounts the cards
 * around the current page: at most nine images alive, three at first paint,
 * against twenty-five in the first draft of this design.
 *
 * DEVIATION worth flagging: the plan said `w185`. Each tile displays about
 * 112pt wide, which is ~336 physical px on a 3x phone — w185 upscales and
 * looks visibly soft, which is the opposite of the brief. `w342` matches the
 * real display size. The mounted-COUNT budget, which is what actually causes
 * mount stutter, is unchanged. One token to revert if you disagree.
 */

/** Reference ratio, measured off the screenshot (682 × 220 device px). */
export const COLLECTION_ASPECT = 2.8;

export interface CollectionCardProps {
  collection: Collection;
  width: number;
  /** The reference badges one card; we badge the strongest. */
  featured?: boolean;
  onPress: (collection: Collection) => void;
}

export function CollectionCard({ collection, width, featured, onPress }: CollectionCardProps) {
  const t = useT();
  const height = Math.round(width / COLLECTION_ASPECT);
  const tileWidth = width / STRIP_TILES;

  const strip = collection.items.slice(0, STRIP_TILES);

  return (
    <PressableScale
      onPress={() => onPress(collection)}
      haptic="light"
      activeScale={0.97}
      accessibilityRole="button"
      accessibilityLabel={collection.title}
      style={{ width }}
    >
      <View
        style={{
          width,
          height,
          borderRadius: R.card,
          overflow: 'hidden',
          backgroundColor: C.surface,
          ...SHADOW.card,
        }}
      >
        {/* The filmstrip. Seamless by construction: no gap, no per-tile radius. */}
        <View className="flex-row" style={{ width, height }}>
          {Array.from({ length: STRIP_TILES }, (_, index) => {
            const item = strip[index];
            // A backdrop is a still; a poster is a portrait. In a 112×120 slot
            // the still crops gracefully and the poster does not, so backdrop
            // leads and poster is only the fallback.
            const source = imageUrl(item?.backdrop_path ?? item?.poster_path ?? null, 'w342');
            // Alternating base tint, painted instantly, so a slow tile is
            // never a blank hole — same rule as the login poster wall.
            const tint = index % 2 === 0 ? C.surface : C.surfaceRaised;

            return (
              <View key={index} style={{ width: tileWidth, height, backgroundColor: tint }}>
                {source && (
                  <Image
                    source={{ uri: source }}
                    style={{ width: tileWidth, height }}
                    contentFit="cover"
                    transition={300}
                    cachePolicy="memory-disk"
                    recyclingKey={item ? `${item.media_type}-${item.tmdb_id}` : undefined}
                  />
                )}
              </View>
            );
          })}
        </View>

        {/* Scrim: darkest at the bottom-start where the title sits, so the
            artwork survives everywhere else. */}
        <LinearGradient
          colors={['rgba(0,0,0,0.55)', 'rgba(0,0,0,0.15)', 'rgba(0,0,0,0.88)']}
          locations={[0, 0.4, 1]}
          style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
        />

        {/* Top-start: where the reference puts the list author's avatar. Ours
            is the app itself, because these are the app's own collections. */}
        <View
          className="flex-row items-center"
          style={{ position: 'absolute', top: SPACE.md, start: SPACE.md, gap: 7 }}
        >
          <LogoMark size={22} />
          <AppText variant="caption" className="text-white/90">
            {BRAND.he}
          </AppText>
        </View>

        {featured && (
          <View
            className="flex-row items-center"
            style={{
              position: 'absolute',
              top: SPACE.md,
              end: SPACE.md,
              gap: 5,
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: R.pill,
              backgroundColor: C.accent,
            }}
          >
            <Ionicons name="star" size={10} color={C.onAccent} />
            <AppText variant="caption" style={{ color: C.onAccent }}>
              {t('discover.featured')}
            </AppText>
          </View>
        )}

        <View
          style={{ position: 'absolute', bottom: SPACE.md, start: SPACE.md, end: SPACE.md, gap: 2 }}
        >
          <AppText variant="subtitle" numberOfLines={2} className="text-white">
            {collection.title}
          </AppText>
          <AppText variant="caption" className="text-white/70">
            {t('discover.collectionCount', { count: collection.count })}
          </AppText>
        </View>
      </View>
    </PressableScale>
  );
}
