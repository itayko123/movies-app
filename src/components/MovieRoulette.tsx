import { useCallback, useEffect, useRef, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { Burst, Shockwave, easeBack, easeOut, popScale, useCelebrationProgress } from '@/components/Celebration';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import { imageUrl } from '@/lib/tmdb';
import { useT } from '@/i18n';
import { C } from '@/theme/tokens';

/**
 * Minimal shape the reel needs.
 *
 * Deliberately narrower than MediaDraft or MediaItemRow so the caller can feed
 * it either — the deck holds hydrated rows, the watchlist holds drafts, and the
 * roulette should be able to draw from both without a conversion step.
 */
export interface RouletteItem {
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  title: string;
  poster_path: string | null;
  /** Shown in the result panel once the reel lands. All optional — a saved
   *  title from an older build may predate these fields. */
  overview?: string | null;
  vote_average?: number | null;
  release_year?: number | null;
  genres?: string[];
}

/** How long the reel runs before it lands. */
const SPIN_MS = 1700;
/** Fastest and slowest frame gaps — the reel decelerates between them. */
const FAST_TICK = 55;
const SLOW_TICK = 260;

const POSTER = { width: 200, height: 300 } as const;

/**
 * Slot-machine picker for when nothing appeals.
 *
 * ── Why setInterval-style timers and not an animation library ──────────────
 * Reanimated is inert under react-native-web in this project, and
 * requestAnimationFrame has been proven not to fire at all when the page is not
 * compositing (193 samples, zero callbacks — see Celebration.tsx). The reel is
 * therefore driven by chained setTimeouts, which fire regardless, and the
 * landing state is set by the same timer that ends the spin rather than being
 * inferred from an animation completing. Nothing here can leave the user
 * looking at a frozen or invisible reel.
 *
 * The deceleration is a cubic on elapsed time, which is what makes it read as a
 * slot machine rather than a slideshow that stops abruptly.
 */
export function MovieRoulette({
  items,
  onClose,
  onOpen,
}: {
  items: RouletteItem[];
  onClose: () => void;
  onOpen: (item: RouletteItem) => void;
}) {
  const t = useT();
  const { width, height } = useWindowDimensions();

  const [reel, setReel] = useState(0);
  const [result, setResult] = useState<RouletteItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spinId = useRef(0);

  /**
   * Latest pool, read through a ref rather than captured.
   *
   * `items` is a memo over the deck's buffer, and that buffer grows every time
   * a background page lands. Closing over it would make `spin` — and therefore
   * the mount effect below — change identity mid-spin, tearing down the reel
   * and starting it again. On a slow connection, with pages arriving every
   * couple of seconds, the wheel could restart indefinitely and never land.
   */
  const latestItems = useRef(items);
  latestItems.current = items;

  const spin = useCallback(() => {
    const pool = latestItems.current;
    if (pool.length === 0) return;
    const run = ++spinId.current;
    setResult(null);

    const start = Date.now();
    let tick = 0;
    const step = () => {
      // Any newer spin, or an unmount, invalidates this run.
      if (spinId.current !== run) return;
      const elapsed = Date.now() - start;
      const current = latestItems.current;
      if (current.length === 0) return;

      if (elapsed >= SPIN_MS) {
        // The landed card is chosen up front by a fair index — the reel is
        // display, the pick is not "wherever it happened to stop", which would
        // bias toward whichever poster the timing drift favoured.
        const picked = current[Math.floor(Math.random() * current.length)]!;
        setResult(picked);
        hapticSuccess();
        return;
      }

      setReel((index) => (index + 1) % current.length);
      // Every OTHER frame early on: at a 55ms gap this would otherwise queue
      // ~30 taptic events in under two seconds, which on iOS backs up the
      // haptic engine and lands the "you won" pulse late, after the reveal.
      if (tick % 2 === 0 || elapsed > SPIN_MS * 0.6) hapticLight();
      tick++;

      const ratio = elapsed / SPIN_MS;
      const gap = FAST_TICK + (SLOW_TICK - FAST_TICK) * ratio * ratio * ratio;
      timer.current = setTimeout(step, gap);
    };

    step();
  }, []);

  // Spin as soon as it opens: the user already asked for a pick by getting
  // here, so making them press a second button would be pure friction.
  // Empty deps — `spin` is now identity-stable, so this runs exactly once per
  // mount and the cleanup is the only thing that ever stops a run.
  useEffect(() => {
    spin();
    return () => {
      // Invalidate the run FIRST: a timeout that has already fired and is
      // waiting on the JS queue cannot be cleared, only ignored.
      spinId.current++;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [spin]);

  const spinning = result == null;
  const shown = result ?? items[reel] ?? null;
  const poster = shown ? imageUrl(shown.poster_path, 'w500') : null;

  const reveal = useCelebrationProgress(!spinning, 1100);
  const cardScale = spinning ? 1 : popScale(easeBack(Math.min(reveal / 0.6, 1)), 0.94);
  const actions = spinning ? 0 : 0.6 + 0.4 * easeOut(Math.min(reveal / 0.7, 1));

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={t('roulette.title')}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 44,
      }}
    >
      <LinearGradient
        colors={['rgba(13,13,18,0.94)', 'rgba(30,12,40,0.97)', 'rgba(13,13,18,0.99)']}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />

      {/* Dismiss lives top-end and is present from the first frame — a modal
          that can only be closed after an animation finishes is a trap. */}
      <PressableScale
        onPress={onClose}
        haptic="light"
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        style={{ position: 'absolute', top: 56, insetInlineEnd: 20, padding: 10 }}
      >
        <Ionicons name="close" size={26} color="#FFFFFF" />
      </PressableScale>

      {items.length === 0 ? (
        <View className="px-10 gap-3 items-center">
          <Ionicons name="sparkles-outline" size={40} color="#A78BFA" />
          <AppText variant="body" className="text-center text-txt-secondary">
            {t('roulette.empty')}
          </AppText>
        </View>
      ) : (
        <View className="items-center gap-5">
          <AppText variant="caption" className="text-txt-secondary">
            {spinning ? t('roulette.spinning') : t('roulette.result')}
          </AppText>

          <View style={{ alignItems: 'center', justifyContent: 'center' }}>
            {!spinning && (
              <>
                <Shockwave progress={reveal} color="#A78BFA" maxSize={Math.min(width, 340)} />
                <Burst
                  progress={reveal}
                  radius={Math.min(width * 0.34, 150)}
                  count={16}
                  colors={['#A78BFA', '#FBBF24', '#00B8D9']}
                />
              </>
            )}

            <View
              style={{
                width: POSTER.width,
                height: POSTER.height,
                borderRadius: 18,
                overflow: 'hidden',
                backgroundColor: '#121826',
                transform: [{ scale: cardScale }],
              }}
            >
              {poster && (
                <Image
                  key={poster}
                  source={{ uri: poster }}
                  style={{ width: POSTER.width, height: POSTER.height }}
                  contentFit="cover"
                  // No cross-fade while spinning: a 180ms fade at a 55ms tick
                  // would blur the reel into grey mush.
                  transition={spinning ? 0 : 220}
                  cachePolicy="memory-disk"
                />
              )}
            </View>
          </View>

          <AppText
            variant="subtitle"
            numberOfLines={2}
            className="text-center text-white"
            style={{ maxWidth: 280, opacity: spinning ? 0.35 : 1 }}
          >
            {shown?.title ?? ''}
          </AppText>

          {/*
            Details panel — gated on `result`, so it renders ONLY after the reel
            has landed. Mounting it mid-spin would mean a wall of text changing
            every 55ms next to the poster, which is unreadable and reads as a
            glitch. It also has to be absent rather than transparent: an
            overview faded to opacity 0 still occupies its height, and the
            layout would jump each time a longer synopsis cycled through.
          */}
          {!spinning && result && (
            <View
              className="items-center gap-2"
              style={{ maxWidth: 300, opacity: actions, paddingHorizontal: 4 }}
            >
              <View className="flex-row items-center gap-3">
                <View className="flex-row items-center gap-1">
                  <Ionicons
                    name={result.media_type === 'tv' ? 'tv' : 'film'}
                    size={12}
                    color="#94A3B8"
                  />
                  <AppText variant="caption" className="text-txt-secondary">
                    {result.media_type === 'tv' ? t('deck.series') : t('deck.movie')}
                  </AppText>
                </View>

                {result.release_year != null && (
                  <AppText variant="caption" className="text-txt-secondary">
                    {result.release_year}
                  </AppText>
                )}

                {result.vote_average != null && result.vote_average > 0 && (
                  <View className="flex-row items-center gap-1">
                    <Ionicons name="star" size={12} color="#FBBF24" />
                    <AppText variant="caption" className="text-txt-secondary">
                      {result.vote_average.toFixed(1)}
                    </AppText>
                  </View>
                )}
              </View>

              {result.overview ? (
                <AppText
                  variant="caption"
                  numberOfLines={4}
                  className="text-center text-txt-secondary"
                >
                  {result.overview}
                </AppText>
              ) : null}
            </View>
          )}

          {/* Rendered only once landed, so the buttons cannot be tapped
              mid-spin and act on a title the user never actually got. */}
          {!spinning && result && (
            <View className="flex-row items-center gap-3" style={{ opacity: actions }}>
              <PressableScale
                onPress={spin}
                haptic="medium"
                accessibilityRole="button"
                style={{
                  borderRadius: 999,
                  paddingHorizontal: 22,
                  paddingVertical: 12,
                }}
              >
                <AppText variant="bodyStrong" className="text-white">
                  {t('roulette.again')}
                </AppText>
              </PressableScale>

              <PressableScale
                onPress={() => onOpen(result)}
                haptic="medium"
                accessibilityRole="button"
                style={{
                  backgroundColor: '#00B8D9',
                  borderRadius: 999,
                  paddingHorizontal: 26,
                  paddingVertical: 12,
                }}
              >
                <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
                  {t('roulette.view')}
                </AppText>
              </PressableScale>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

/** Floating wand that opens the roulette. */
export function RouletteButton({ onPress }: { onPress: () => void }) {
  const t = useT();
  return (
    <PressableScale
      onPress={onPress}
      haptic="medium"
      activeScale={0.9}
      accessibilityRole="button"
      accessibilityLabel={t('roulette.open')}
      style={{
        position: 'absolute',
        // Logical inset so it mirrors to the other side in Hebrew, and clear of
        // the tab bar.
        insetInlineEnd: 18,
        // Clears the deck action row. Measured: the row occupies 78–134px
        // from the bottom edge, so anything lower than ~146 overlaps the
        // end-most verdict button and steals its taps.
        bottom: 150,
        width: 54,
        height: 54,
        borderRadius: 27,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#00B8D9',
        boxShadow: '0px 8px 22px rgba(0,184,217,0.40)',
        elevation: 8,
        zIndex: 20,
      }}
    >
      <Ionicons name="color-wand" size={24} color="#000000" />
    </PressableScale>
  );
}
