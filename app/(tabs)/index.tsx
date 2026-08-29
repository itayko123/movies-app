import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { DeckSkeleton } from '@/components/Skeleton';
import {
  SwipeCard,
  CardVisual,
  ExitingCard,
  CARD_EXIT_MS,
  type CardExit,
  type CardTransform,
} from '@/components/SwipeCard';
import { StreakBadge } from '@/components/StreakBadge';
import { StreakCelebration } from '@/components/StreakCelebration';
import { LevelBadge } from '@/components/LevelBadge';
import { LevelUpCelebration } from '@/components/LevelUpCelebration';
import { MovieRoulette, RouletteButton, type RouletteItem } from '@/components/MovieRoulette';
import { useShake } from '@/hooks/useShake';
import { DeckActions } from '@/components/DeckActions';
import { SaveSheet } from '@/components/SaveSheet';
import { DeckFilterBar } from '@/components/DeckFilterBar';
import { SwipeTutorial } from '@/components/SwipeTutorial';
import { AdCard } from '@/components/AdCard';
import { useSwipeDeck } from '@/hooks/useSwipeDeck';
import { useCardRuntime } from '@/hooks/useCardRuntime';
import { usePosterPalette } from '@/hooks/usePosterPalette';
import { imageUrl, regionMeta } from '@/lib/tmdb';
import { setHeroSource } from '@/lib/heroHandoff';
import { hapticWarning } from '@/lib/haptics';
import { AD_INTERVAL, adsSupported } from '@/lib/ads';
import { useT } from '@/i18n';
import { useGenreLabel } from '@/i18n/genres';
import { useAppStore } from '@/state/store';
import type { MediaItemRow, SwipeDirection } from '@/types/media';
import { C } from '@/theme/tokens';

/**
 * The deck is designed for a phone. Without a cap it stretches to the full
 * desktop width on web and the poster card ends up wide and letterboxed, so
 * the column is centred at a phone-like width. No effect on device builds.
 */
const PHONE_COLUMN = { width: '100%', maxWidth: 440, alignSelf: 'center' } as const;

/**
 * Clearance for the floating glass tab bar.
 *
 * The bar is `position: 'absolute'` (see (tabs)/_layout.tsx) so it contributes
 * nothing to layout — the deck has to reserve the space itself or the action
 * buttons sit underneath it. Mirrors the heights declared there; on iOS that
 * figure already covers the home indicator.
 */
const TAB_BAR_INSET = (Platform.OS === 'ios' ? 84 : 68) + 10;

/**
 * How far the next card's top edge sits ABOVE the top card's, at rest.
 *
 * Measured off reference (9): the peeking card's top edge is ~19pt above the
 * live card's, and it is visibly narrower.
 *
 * The number has to clear the inset the scale already creates. Scaling 0.92
 * about the centre pulls the top edge DOWN by height x 0.04 -- about 20pt on a
 * typical deck -- so the translate must pay that back before any of the card
 * shows. 42 pays back that ~20 and leaves ~19 of visible peek -- measured on
 * a 507pt deck as 151 - 136 -- and it degrades sanely across screen heights,
 * giving a deeper peek on a short deck and a shallower one on a tall deck.
 *
 * At interactionProgress 1 this resolves to 0, which is exactly where the
 * promoted card starts -- so the handoff endpoint is unchanged.
 */
const STACK_PEEK = 42;

export default function DiscoverScreen() {
  const t = useT();
  const genreLabel = useGenreLabel();
  const router = useRouter();

  const deck = useSwipeDeck();
  const isPremium = useAppStore((s) => s.isPremium);
  const swipesRemaining = useAppStore((s) => s.swipesRemaining);
  const deckLocked = useAppStore((s) => s.deckLocked);
  const setDeckLocked = useAppStore((s) => s.setDeckLocked);
  const hasSeenTutorial = useAppStore((s) => s.hasSeenTutorial);
  const streakCelebration = useAppStore((s) => s.streakCelebration);
  const clearStreakCelebration = useAppStore((s) => s.clearStreakCelebration);
  const levelCelebration = useAppStore((s) => s.levelCelebration);
  const clearLevelCelebration = useAppStore((s) => s.clearLevelCelebration);
  const ensureQuests = useAppStore((s) => s.ensureQuests);
  const completeTutorial = useAppStore((s) => s.completeTutorial);

  // Rolls the day's quests over when the app has been open across midnight.
  useEffect(() => {
    ensureQuests();
  }, [ensureQuests]);

  const [rouletteOpen, setRouletteOpen] = useState(false);
  const library = useAppStore((s) => s.library);

  /**
   * What the roulette can land on.
   *
   * The full buffered POOL first (already taste-filtered and already fetched,
   * so opening the wheel costs no network), then saved titles — which matter
   * because the deck can legitimately be empty when a strict filter runs dry,
   * and a roulette that says "nothing to pick from" while the user has forty
   * saved films would look broken.
   *
   * `deck.pool`, NOT `deck.cards`: cards is the two-card rendered stack, so
   * feeding it here gave the wheel a choice of two titles and made the spin
   * pure theatre. The pool holds the whole buffer, normally 20+.
   */
  const rouletteItems = useMemo(() => {
    const seen = new Set<string>();
    const out: RouletteItem[] = [];
    const push = (item: RouletteItem) => {
      // MOVIES ONLY. The roulette answers "what do I put on right now" — a
      // 60-episode series is not an answer to that question, so TV is filtered
      // out at the single point where the pool is assembled rather than in the
      // wheel, which keeps the spin honest: every slot the reel shows is a
      // slot it could actually land on.
      if (item.media_type !== 'movie') return;
      const key = `${item.media_type}:${item.tmdb_id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };

    for (const card of deck.pool) push(card);
    for (const entry of Object.values(library)) {
      if (entry.direction === 'superlike' || entry.direction === 'like') push(entry.item);
    }
    return out;
  }, [deck.pool, library]);

  const openRoulette = useCallback(() => setRouletteOpen(true), []);

  // Shake is a shortcut to the same wheel, never the only way in: the wand
  // button is always present, so a device with no accelerometer (or a browser
  // that withholds motion events) loses nothing.
  useShake(openRoulette, !rouletteOpen && !deckLocked);

  const openDetailById = useCallback(
    (item: RouletteItem) => {
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

  // Action-button swipe requests are passed down as a prop (see SwipeCard):
  // the card remounts on every swipe, and a ref would be null after that.
  const [pendingAction, setPendingAction] = useState<SwipeDirection | null>(null);
  const interactionProgress = useSharedValue(0);
  const [swipeCount, setSwipeCount] = useState(0);
  const [showAd, setShowAd] = useState(false);

  const topCard = deck.cards[0] ?? null;
  const nextCard = deck.cards[1] ?? null;
  /**
   * Mounted but invisible, purely so its poster is decoded before it is ever
   * shown. See VISIBLE_COUNT — prefetching warms the cache, it does not decode,
   * and the decode was landing on the frame the card first appeared.
   */
  const thirdCard = deck.cards[2] ?? null;

  // The focused poster drives the app-wide dynamic theme.
  usePosterPalette(topCard ? imageUrl(topCard.poster_path, 'w500') : null);

  // Runtime is only on TMDB's detail endpoint, so it's fetched for the top card
  // alone rather than for all 20 buffered cards.
  const fetchedRuntime = useCardRuntime(topCard?.tmdb_id ?? null, topCard?.media_type ?? null);

  /**
   * Runtime is held back while a finger is down.
   *
   * It is the one card prop that can change on a NETWORK timer rather than in
   * response to the user, so it is the one thing that can still re-render the
   * card mid-drag after every other source has been locked out. Swipe
   * immediately on a freshly-promoted card and the detail request lands
   * underneath the gesture, the metadata row gains "· 1h 58m", and the text
   * reflows under the thumb.
   *
   * The value is not dropped, only deferred to the moment the gesture settles.
   */
  const [topRuntime, setTopRuntime] = useState<number | null>(null);
  const gestureDown = useRef(false);
  const deferredRuntime = useRef<number | null>(null);

  useEffect(() => {
    if (gestureDown.current) {
      deferredRuntime.current = fetchedRuntime;
      return;
    }
    setTopRuntime(fetchedRuntime);
  }, [fetchedRuntime]);

  /**
   * Single stable gesture handle: drives the deck's refill lock AND the
   * runtime gate above. Stable identity for the same reason the deck's own
   * handle is — it is a prop on the memoised card.
   */
  const deckSetGestureActive = deck.setGestureActive;
  const onGestureActiveChange = useCallback(
    (active: boolean) => {
      gestureDown.current = active;
      deckSetGestureActive(active);
      if (!active && deferredRuntime.current !== null) {
        setTopRuntime(deferredRuntime.current);
        deferredRuntime.current = null;
      }
    },
    [deckSetGestureActive],
  );

  useEffect(() => {
    if (deckLocked) hapticWarning();
  }, [deckLocked]);

  /**
   * Cards that have committed and are still flying out.
   *
   * A list rather than a single slot because the deck now advances instantly:
   * swipe quickly enough and the second card commits while the first is still
   * in the air. Capped, because a very fast run of swipes should drop old
   * ghosts rather than stack up animated views nobody is looking at.
   */
  /**
   * Transform slots, rotated between cards.
   *
   * The deck owns these rather than each card, so a swipe's fly-out survives
   * the card that started it: the exiting card and the ghost that replaces it
   * read the SAME shared values, and the animation never restarts. Four is
   * enough to guarantee a slot is never reused while still airborne — at most
   * three exits are kept, and an exit lasts 280ms.
   */
  const s0x = useSharedValue(0);
  const s0y = useSharedValue(0);
  const s1x = useSharedValue(0);
  const s1y = useSharedValue(0);
  const s2x = useSharedValue(0);
  const s2y = useSharedValue(0);
  const s3x = useSharedValue(0);
  const s3y = useSharedValue(0);
  const slots = useMemo<CardTransform[]>(
    () => [
      { x: s0x, y: s0y },
      { x: s1x, y: s1y },
      { x: s2x, y: s2y },
      { x: s3x, y: s3y },
    ],
    [s0x, s0y, s1x, s1y, s2x, s2y, s3x, s3y],
  );
  const [activeSlot, setActiveSlot] = useState(0);

  const [exits, setExits] = useState<CardExit[]>([]);

  /**
   * Clears the last ghosts once swiping stops.
   *
   * Ghosts are normally retired by the NEXT swipe (see handleSwipe), which
   * costs no extra render. That leaves only the tail of a burst — the final
   * one or two, with no following swipe to prune them — so a single timer,
   * restarted per swipe, sweeps those. One render after a burst instead of one
   * render per card, 280ms after each.
   */
  const sweepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (sweepTimer.current) clearTimeout(sweepTimer.current);
    },
    [],
  );

  /**
   * The scale the incoming card already had as the behind-card.
   *
   * Read during the render that promotes it, so the new top card picks its
   * spring up exactly where the old one left it instead of snapping back down.
   */
  const entryFrom = useRef(0);

  const handleSwipe = useCallback(
    (item: MediaItemRow, direction: SwipeDirection) => {
      /*
        By the time this runs the card is ALREADY flying out — the gesture
        started the animation on the UI thread before handing control back
        here (see launchExit). Everything below is bookkeeping that the
        animation does not wait for.
      */
      const now = Date.now();
      const usedSlot = slots[activeSlot]!;
      const nextSlot = (activeSlot + 1) % slots.length;

      // Reset the incoming card's slot before it renders, so a recycled slot
      // never starts life holding the tail of an old animation.
      slots[nextSlot]!.x.value = 0;
      slots[nextSlot]!.y.value = 0;
      setActiveSlot(nextSlot);

      // The ghost adopts the slot the animation is running on. Ghosts whose
      // animation has finished are dropped in the SAME update — retiring them
      // costs nothing extra rather than a render each.
      setExits((current) => {
        const live = current.filter((exit) => now - exit.at < CARD_EXIT_MS);
        return [
          ...live,
          { id: `${item.id}:${now}`, item, direction, transform: usedSlot, at: now },
        ].slice(-3);
      });

      // Restart the tail sweep for whatever is still airborne when swiping stops.
      if (sweepTimer.current) clearTimeout(sweepTimer.current);
      sweepTimer.current = setTimeout(() => setExits([]), CARD_EXIT_MS + 40);

      // Capture where the behind-card had grown to, THEN reset the shared
      // value for the card that is about to take its place. Order matters:
      // after this line the progress belongs to the new pair.
      entryFrom.current = Math.min(Math.max(interactionProgress.value, 0), 1);
      interactionProgress.value = 0;

      /*
        Release the runtime gate here rather than trusting the gesture to do
        it. The card now commits DURING its own gesture callback and is
        unmounted by the state update below, so `onFinalize` — which is what
        normally lowers this flag — may never run for it. Left raised, every
        subsequent runtime would be deferred to a gesture-end that never comes,
        and the metadata line would stop updating for the rest of the session.

        The pending value is discarded, not applied: it was resolved for the
        card that just left. The incoming card's own request repopulates it.
      */
      gestureDown.current = false;
      deferredRuntime.current = null;

      deck.swipe(item, direction);
      setSwipeCount((count) => {
        const next = count + 1;
        if (!isPremium && adsSupported() && next % AD_INTERVAL === 0) setShowAd(true);
        return next;
      });
    },
    [deck, isPremium, interactionProgress, slots, activeSlot],
  );

  /**
   * Stable handles handed to the memoised SwipeCard.
   *
   * `handleSwipe` changes identity whenever the deck's queue moves, which
   * would defeat memoisation — but a memoised child cannot refresh a ref of
   * its own (it never re-renders), so the indirection has to live here. These
   * two callbacks never change identity and always invoke the latest logic.
   */
  const latest = useRef({ handleSwipe, topCard });
  latest.current = { handleSwipe, topCard };

  const onCardSwipe = useCallback((direction: SwipeDirection) => {
    const { topCard: card, handleSwipe: swipe } = latest.current;
    if (card) swipe(card, direction);
  }, []);

  const clearPendingAction = useCallback(() => setPendingAction(null), []);

  /**
   * Save sheet. Holds its own copy of the card rather than reading `topCard`
   * at render time: the deck promotes a new card the instant a swipe commits,
   * and a sheet that re-pointed itself mid-interaction would file the wrong
   * title.
   */
  const [saveSheetItem, setSaveSheetItem] = useState<MediaItemRow | null>(null);
  const openSaveSheet = useCallback(() => {
    const card = latest.current.topCard;
    if (card) setSaveSheetItem(card);
  }, []);
  const closeSaveSheet = useCallback(() => setSaveSheetItem(null), []);

  const openDetail = useCallback(
    (item: MediaItemRow) => {
      router.push({
        pathname: '/media/[id]',
        params: {
          id: String(item.tmdb_id),
          type: item.media_type,
          mediaItemId: item.id,
          title: item.title,
          poster: item.poster_path ?? '',
        },
      });
    },
    [router],
  );

  /**
   * Ref on the card stack, used purely to measure it for the hero handoff.
   *
   * measureInWindow is async, so navigation happens in its callback — but the
   * push is ALSO issued if measuring fails or the ref is gone, because a
   * missing transition must never turn into a tap that does nothing.
   */
  const cardStackRef = useRef<View>(null);

  const onCardOpenDetail = useCallback(() => {
    const card = latest.current.topCard;
    if (!card) return;
    const node = cardStackRef.current;
    if (!node) {
      openDetail(card);
      return;
    }
    node.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) setHeroSource({ x, y, width, height });
      openDetail(card);
    });
  }, [openDetail]);

  const nextCardStyle = useAnimatedStyle(() => ({
    transform: [
      // 0.92 IS LOAD-BEARING. The promoted card's entry spring runs the same
      // 0.92 -> 1.0 curve (SwipeCard cardStyle), and `entryFrom` hands the
      // progress across at the moment of promotion so the new top card
      // continues the scale instead of restarting it. Change this number here
      // and every swipe gains a visible jolt.
      { scale: 0.92 + 0.08 * interactionProgress.value },
      // NEGATIVE: the stack peeks ABOVE the top card, as in the reference.
      // It was +18, which pushed the behind-card down into the region the
      // 0.92 scale had already inset — so it was hidden completely and the
      // deck read as a single card with nothing behind it.
      { translateY: -STACK_PEEK * (1 - interactionProgress.value) },
    ],
  }));

  const region = regionMeta(deck.query.region);

  /** One line explaining why these cards are being shown. */
  const sourceLabel = (() => {
    // Origin is the strongest constraint, so it leads the explanation.
    const prefix = region.country ? `${region.flag} ${region.label} · ` : '';
    return prefix + rawSourceLabel();
  })();

  function rawSourceLabel(): string {
    switch (deck.query.source) {
      case 'region':
        return t('filters.regionOnly');
      case 'pinned':
        return t('filters.pinned', {
          genre: genreLabel(deck.query.genres[0] ?? ''),
        });
      case 'taste':
        return t('filters.tuning');
      case 'onboarding':
        return t('filters.onboarding');
      default:
        return t('filters.trending');
    }
  }

  return (
    // `edges` excludes the bottom: the glass tab bar already owns that inset,
    // and doubling it would float the deck above the home indicator.
    <SafeAreaView edges={['top']} style={{ flex: 1 }}>
      {/* Sticky header: title, quota, format toggle, genre pills */}
      <View className="px-5 pb-2 gap-2.5" style={PHONE_COLUMN}>
        <View className="flex-row items-center justify-between">
          <View className="flex-1">
            <AppText variant="title" className="text-brand">
              {t('common.appName')}
            </AppText>
            <AppText variant="caption" numberOfLines={1}>
              {sourceLabel}
            </AppText>
          </View>
          <View className="flex-row items-center gap-2">
            <LevelBadge compact />
            <StreakBadge />
            {!isPremium && swipesRemaining != null && (
              <GlassView className="rounded-full px-4 py-1.5">
                <AppText variant="caption" className="text-txt-secondary">
                  {t('deck.swipesLeft', { count: Math.max(swipesRemaining, 0) })}
                </AppText>
              </GlassView>
            )}
          </View>
        </View>

        {/* Region, format and genre — one rail. See DeckFilterBar. */}
        <DeckFilterBar />
      </View>

      {/* Deck. `flex-1` makes it the remainder, so every pixel of header above
          comes straight out of the poster — which is why the header is kept to
          three compact bands. `minHeight: 0` lets it shrink inside the flex
          parent on small screens instead of overflowing the tab bar. */}
      <View
        className="flex-1 px-5"
        style={[PHONE_COLUMN, { minHeight: 0, paddingBottom: TAB_BAR_INSET }]}
      >
        {deck.isLoading ? (
          <DeckSkeleton />
        ) : deck.isError ? (
          <View className="flex-1 items-center justify-center gap-4 px-8">
            <AppText variant="subtitle" className="text-center">
              {t('common.error')}
            </AppText>
            <PressableScale
              onPress={deck.refetch}
              haptic="medium"
              accessibilityRole="button"
              style={{
                backgroundColor: '#00B8D9',
                borderRadius: 999,
                paddingHorizontal: 32,
                paddingVertical: 12,
              }}
            >
              <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
                {t('common.retry')}
              </AppText>
            </PressableScale>
          </View>
        ) : topCard == null ? (
          /*
            Honest end state. When a strict query runs dry the deck STOPS here
            rather than widening to keep cards on screen — a user who asked for
            Israeli TV (58 titles in all of TMDB) should be told they reached the
            end, not quietly handed Hollywood blockbusters.
          */
          <View className="flex-1 items-center justify-center gap-3 px-8">
            <Ionicons
              name={deck.isExhausted ? 'checkmark-done-circle-outline' : 'film-outline'}
              size={44}
              color={deck.isExhausted ? '#00B8D9' : '#64748B'}
            />
            <AppText variant="subtitle" className="text-center">
              {deck.isExhausted ? t('deck.exhaustedTitle') : t('deck.empty')}
            </AppText>
            <AppText variant="body" className="text-center">
              {deck.isExhausted
                ? t('deck.exhaustedBody', {
                    scope: region.country ? region.label : t('filters.forYou'),
                  })
                : t('deck.emptyBody')}
            </AppText>
            <PressableScale
              onPress={deck.refetch}
              haptic="medium"
              accessibilityRole="button"
              style={{
                backgroundColor: '#00B8D9',
                borderRadius: 999,
                paddingHorizontal: 32,
                paddingVertical: 12,
                marginTop: 8,
              }}
            >
              <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
                {t('common.retry')}
              </AppText>
            </PressableScale>
          </View>
        ) : (
          <View className="flex-1">
            <View ref={cardStackRef} className="flex-1">
              {/* Decode-ahead layer. Zero opacity and untouchable — it exists
                  only so the artwork is ready before promotion. */}
              {thirdCard && (
                <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: 0 }]}>
                  <CardVisual item={thirdCard} />
                </View>
              )}

              {nextCard && (
                // Explicit style: NativeWind classes are dropped on Animated.View.
                <Animated.View style={[StyleSheet.absoluteFill, nextCardStyle]}>
                  <CardVisual item={nextCard} />
                </Animated.View>
              )}
              <SwipeCard
                key={topCard.id}
                item={topCard}
                transform={slots[activeSlot]!}
                runtimeMinutes={topRuntime}
                interactionProgress={interactionProgress}
                entryFrom={entryFrom.current}
                pendingAction={pendingAction}
                onPendingHandled={clearPendingAction}
                onSwipe={onCardSwipe}
                onOpenDetail={onCardOpenDetail}
                onGestureActiveChange={onGestureActiveChange}
              />

              {/* Departing cards, above the live one and untouchable. Rendered
                  last so a ghost never covers the card the user is now on with
                  an interactive surface — see ExitingCard. */}
              {exits.map((exit) => (
                <ExitingCard key={exit.id} exit={exit} />
              ))}

              {showAd && !isPremium && adsSupported() && (
                <AdCard label={t('deck.adLabel')} onDismiss={() => setShowAd(false)} />
              )}
            </View>

            <View className="pt-5">
              <DeckActions
                onAction={setPendingAction}
                onLongPressSave={openSaveSheet}
                labels={{
                  like: t('deck.like'),
                  nope: t('deck.nope'),
                  superlike: t('deck.watchlist'),
                  seen: t('deck.seen'),
                }}
              />
            </View>
          </View>
        )}
      </View>

      {/*
        First-run gesture guide. Deliberately rendered at SCREEN level rather
        than inside the card stack: nested in the deck it only mounted once a
        card had loaded, so on a slow first fetch it was skipped entirely and
        the user never saw it.
      */}
      {/* Wand is hidden while any overlay owns the screen, so it cannot be
          tapped through a celebration or the quota lock. */}
      {!rouletteOpen && !deckLocked && streakCelebration == null && levelCelebration == null && (
        <RouletteButton onPress={openRoulette} />
      )}

      {/* Save sheet. Screen level, above the deck and the wand, so nothing
          behind it stays tappable while it is open. */}
      {saveSheetItem && <SaveSheet item={saveSheetItem} onClose={closeSaveSheet} />}

      {rouletteOpen && (
        <MovieRoulette
          items={rouletteItems}
          onClose={() => setRouletteOpen(false)}
          onOpen={(item) => {
            setRouletteOpen(false);
            openDetailById(item);
          }}
        />
      )}

      {streakCelebration != null && (
        <StreakCelebration days={streakCelebration} onDismiss={clearStreakCelebration} />
      )}

      {levelCelebration != null && (
        <LevelUpCelebration level={levelCelebration} onDismiss={clearLevelCelebration} />
      )}

      {!hasSeenTutorial && <SwipeTutorial onDismiss={completeTutorial} />}

      {/* Server-enforced daily quota reached */}
      {deckLocked && (
        <View
          className="absolute items-center justify-center px-8"
          style={{ top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.75)' }}
        >
          <GlassView className="rounded-sheet w-full p-8 items-center gap-3">
            <Ionicons name="hourglass-outline" size={40} color="#00B8D9" />
            <AppText variant="title" className="text-center">
              {t('deck.limitTitle')}
            </AppText>
            <AppText variant="body" className="text-center">
              {t('deck.limitBody')}
            </AppText>
            <PressableScale
              onPress={() => {
                setDeckLocked(false);
                router.push('/paywall');
              }}
              haptic="medium"
              accessibilityRole="button"
              style={{
                backgroundColor: '#00B8D9',
                borderRadius: 999,
                paddingHorizontal: 40,
                paddingVertical: 14,
                marginTop: 12,
              }}
            >
              <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
                {t('common.upgrade')}
              </AppText>
            </PressableScale>
          </GlassView>
        </View>
      )}
    </SafeAreaView>
  );
}
