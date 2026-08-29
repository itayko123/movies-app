import { memo, useMemo } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { imageUrl } from '@/lib/tmdb';
import { C, R } from '@/theme/tokens';

/** Column tuning. Middle column runs the other way and slower, so the wall
 *  never reads as one sheet sliding. */
const COLUMNS = [
  { direction: -1, duration: 42000 },
  { direction: 1, duration: 54000 },
  { direction: -1, duration: 36000 },
] as const;

const GUTTER = 10;
/** Tiles per column before the strip repeats. */
const PER_COLUMN = 8;

export interface PosterWallProps {
  /** TMDB poster paths. May be empty — the wall renders and animates anyway. */
  posters?: string[];
  /** Fraction of screen height the wall occupies. */
  heightRatio?: number;
}

/**
 * The auto-scrolling wall of posters behind the login screen.
 *
 * ── The 0ms rule ───────────────────────────────────────────────────────────
 * This is the first screen a cold-started user sees, so it may NEVER wait on
 * the network. Every tile renders immediately as a designed gradient card;
 * posters fade in on top of them as expo-image resolves each URL (from its
 * memory-disk cache on any launch after the first, so returning users get real
 * art instantly and offline). There is no loading state and no blank box at
 * any point — if TMDB is unreachable the wall is simply an abstract moving
 * grid, which still looks deliberate.
 *
 * Posters are NOT bundled into the binary: TMDB's licence covers delivery via
 * their API with attribution, not redistribution of studio artwork inside a
 * shipped app. The designed-tile base is what buys the same instant paint
 * without shipping copyrighted art.
 *
 * ── Performance ────────────────────────────────────────────────────────────
 * Each column duplicates its strip twice and animates `translateY` from 0 to
 * -stripHeight on an infinite linear loop. When the first copy has fully left,
 * the second sits exactly where the first began, so resetting to 0 is
 * invisible — a seamless marquee with one shared value per column, running on
 * the UI thread. Three transforms total, no JS per frame, no re-renders. That
 * matters because this screen also runs sign-in work on the JS thread.
 */
function PosterWallImpl({ posters = [], heightRatio = 1 }: PosterWallProps) {
  const { width, height } = useWindowDimensions();

  const columnWidth = (width - GUTTER * 2) / 3;
  const tileHeight = Math.round(columnWidth * 1.5);
  const stripHeight = (tileHeight + GUTTER) * PER_COLUMN;

  // Deal the posters out column by column so neighbouring columns never show
  // the same title side by side.
  const columnPosters = useMemo(() => {
    return COLUMNS.map((_, col) =>
      Array.from({ length: PER_COLUMN }, (_, row) => {
        if (posters.length === 0) return null;
        return posters[(row * COLUMNS.length + col) % posters.length] ?? null;
      }),
    );
  }, [posters]);

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: height * heightRatio,
        overflow: 'hidden',
        flexDirection: 'row',
        gap: GUTTER,
      }}
    >
      {COLUMNS.map((column, i) => (
        <PosterColumn
          key={i}
          posters={columnPosters[i] ?? []}
          width={columnWidth}
          tileHeight={tileHeight}
          stripHeight={stripHeight}
          direction={column.direction}
          duration={column.duration}
          seed={i}
        />
      ))}
    </View>
  );
}

function PosterColumn({
  posters,
  width,
  tileHeight,
  stripHeight,
  direction,
  duration,
  seed,
}: {
  posters: (string | null)[];
  width: number;
  tileHeight: number;
  stripHeight: number;
  direction: number;
  duration: number;
  seed: number;
}) {
  const reduceMotion = useReducedMotion();
  /**
   * Web is inert for Reanimated in this project, and reduced-motion users have
   * opted out — in both cases the wall must still be VISIBLE, just still. The
   * shared value simply never starts, and translateY stays 0. Visibility never
   * depends on the animation running.
   */
  const inert = Platform.OS === 'web' || reduceMotion;
  const offset = useSharedValue(0);

  if (!inert && offset.value === 0) {
    offset.value = withRepeat(
      withTiming(1, { duration, easing: Easing.linear }),
      -1,
      false,
    );
  }

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: direction * offset.value * stripHeight }],
  }));

  return (
    <View style={{ width, overflow: 'hidden' }}>
      <Animated.View
        style={[
          style,
          {
            gap: GUTTER,
            // Start the reversed column pre-scrolled, so the three columns are
            // never momentarily aligned into visible rows.
            marginTop: direction > 0 ? -stripHeight : -(seed * tileHeight) / 2,
          },
        ]}
      >
        {/* Two identical copies: as copy A leaves, copy B is already in place. */}
        {[0, 1].map((copy) =>
          posters.map((path, row) => (
            <PosterTile
              key={`${copy}-${row}`}
              path={path}
              width={width}
              height={tileHeight}
              index={row + seed}
            />
          )),
        )}
      </Animated.View>
    </View>
  );
}

/**
 * One tile. The gradient card underneath is the thing that guarantees the wall
 * is never blank — the poster is a layer ON TOP that fades in when it arrives.
 */
function PosterTile({
  path,
  width,
  height,
  index,
}: {
  path: string | null;
  width: number;
  height: number;
  index: number;
}) {
  const uri = imageUrl(path, 'w342');
  // Alternating tints keep the placeholder grid from looking like a table.
  const tint = index % 2 === 0 ? C.surface : C.surfaceRaised;

  return (
    <View
      style={{
        width,
        height,
        borderRadius: R.media,
        overflow: 'hidden',
        backgroundColor: tint,
      }}
    >
      <LinearGradient
        colors={[tint, 'rgba(0,184,217,0.10)', tint]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {uri && (
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          // Served from disk on every launch after the first, so returning
          // users see real art with no network round-trip.
          cachePolicy="memory-disk"
          transition={420}
          recyclingKey={path ?? undefined}
        />
      )}
    </View>
  );
}

export const PosterWall = memo(PosterWallImpl);
