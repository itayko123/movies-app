import { memo, useCallback, useEffect, useRef } from 'react';
import { I18nManager, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { Image } from 'expo-image';
import { AppText } from '@/components/AppText';
import { ContrastScrim } from '@/theme/ThemeProvider';
import { imageUrl } from '@/lib/tmdb';
import { DECK_POSTER_SIZE } from '@/hooks/useSwipeDeck';
import { SPACE } from '@/theme/tokens';
import { hapticHeavy, hapticLight, hapticMedium, hapticSelection } from '@/lib/haptics';
import { useT } from '@/i18n';
import { useGenreLabel } from '@/i18n/genres';
import type { MediaItemRow, SwipeDirection } from '@/types/media';

const SWIPE_THRESHOLD_RATIO = 0.32;
const VELOCITY_THRESHOLD = 900;
const EXIT_DURATION = 280;

/**
 * RTL-correct swipe physics.
 *
 * `LIKE_AXIS` is the sign that maps a PHYSICAL horizontal translation onto the
 * LOGICAL like/dislike axis. In English (LTR) a physical right-swipe is Like.
 * In Hebrew (RTL) the entire mental model mirrors — "forward" is physically
 * left — so a physical LEFT-swipe must register as Like. We do not just flip
 * badges: every threshold, velocity and fling-exit computation multiplies
 * through this sign so the math itself is direction-aware.
 */
const LIKE_AXIS = I18nManager.isRTL ? -1 : 1;

/**
 * A card that has been swiped and is still in the air.
 *
 * The deck advances the INSTANT a swipe commits, so by the time this is
 * rendered the card it describes is no longer the top card — it is a detached
 * copy finishing its animation over the top of the live one. See ExitingCard.
 */
/** A card's transform, owned by the deck rather than by any one card. */
export interface CardTransform {
  x: SharedValue<number>;
  y: SharedValue<number>;
}

export interface CardExit {
  /** Unique per exit: two rapid swipes must never collide on one node. */
  id: string;
  item: MediaItemRow;
  direction: SwipeDirection;
  /**
   * The transform slot this card was using.
   *
   * The exit animation is ALREADY RUNNING on it by the time this object
   * exists — the ghost adopts the same shared values rather than starting its
   * own, so there is no restart and no gap. See ExitingCard.
   */
  transform: CardTransform;
  /** When it launched — the parent prunes on this rather than per-ghost timers. */
  at: number;
}

/** How long a ghost stays mounted before it is eligible for pruning. */
export const CARD_EXIT_MS = EXIT_DURATION;

export interface SwipeCardProps {
  item: MediaItemRow;
  /**
   * This card's translation, owned by the DECK, not by this component.
   *
   * That ownership is the whole point: when the swipe commits, this component
   * unmounts, but the exit animation is running on these shared values and the
   * deck hands them straight to the ghost. Had the card owned them, the
   * animation would die with it and the replacement would have to start over —
   * which is exactly the freeze this arrangement removes.
   */
  transform: CardTransform;
  /**
   * Commits the swipe. Called on gesture end, AFTER the exit animation has
   * already been started on the UI thread — so nothing visual is waiting on
   * whatever React does in response to this.
   */
  onSwipe: (direction: SwipeDirection) => void;
  onOpenDetail: () => void;
  /** 0 → resting, 1 → at commit threshold. Drives the card behind. */
  interactionProgress: SharedValue<number>;
  /**
   * Scale progress this card already had as the behind-card, 0–1.
   *
   * Promotion is instantaneous, so the card was on screen a frame ago at
   * `0.92 + 0.08 × interactionProgress` — springing it in from a fixed 0.92
   * would visibly shrink a card the user just watched grow. Continuing from
   * where it was makes the promotion invisible.
   */
  entryFrom: number;
  /**
   * Programmatic swipe requested by the action buttons, replayed with the
   * same exit physics as a gesture.
   *
   * Deliberately a prop rather than an imperative ref: the deck remounts this
   * component on every swipe (`key={topCard.id}`), and after a keyed remount
   * a parent-held ref can be left null — which silently killed the buttons.
   */
  pendingAction: SwipeDirection | null;
  /** Called once `pendingAction` has been started, so the parent can clear it. */
  onPendingHandled: () => void;
  /**
   * Reports finger-down / finger-up so the deck can freeze its visible stack.
   * Without this a background page arriving mid-drag re-renders the card being
   * dragged.
   */
  onGestureActiveChange: (active: boolean) => void;
  /** Runtime in minutes, resolved lazily — discover endpoints don't return it. */
  runtimeMinutes: number | null;
}

/**
 * How far the poster is inset beyond the card on each side.
 *
 * The parallax shift can move the artwork by at most this much, so the frame
 * never reveals a bare edge no matter how far the card is dragged.
 */
const PARALLAX_OVERSCAN = 22;

const styles = StyleSheet.create({
  /**
   * The parallax layer is inset by PARALLAX_OVERSCAN on every side and shifts
   * AGAINST the drag, so the poster appears to sit behind the card's frame
   * rather than being painted onto it. The overscan is what stops the shift
   * exposing a bare edge.
   */
  parallaxLayer: {
    position: 'absolute',
    top: -PARALLAX_OVERSCAN,
    bottom: -PARALLAX_OVERSCAN,
    left: -PARALLAX_OVERSCAN,
    right: -PARALLAX_OVERSCAN,
  },

  /*
    Swipe-verdict badge positions.

    These live in StyleSheet rather than as `className`, for the reason spelled
    out at the render site: NativeWind classes are silently dropped on a
    Reanimated Animated.View, which once collapsed this card to height 0 on web.

    `start`/`end` rather than `left`/`right` so LIKE and NOPE swap sides under
    RTL along with the swipe axis itself — the badge must agree with LIKE_AXIS
    or the card says "NOPE" while committing a like.
  */
  badgeStart: { position: 'absolute', top: 32, start: 24 },
  badgeEnd: { position: 'absolute', top: 32, end: 24 },
  // Centred pair: stretched edge-to-edge and centred by alignItems, because
  // alignSelf does nothing on an absolutely-positioned child.
  badgeTop: { position: 'absolute', top: 32, left: 0, right: 0, alignItems: 'center' },
  badgeBottom: { position: 'absolute', bottom: 112, left: 0, right: 0, alignItems: 'center' },
});

/**
 * Static card artwork + metadata — reused by the behind-card preview.
 *
 * Memoised on the item's identity. The deck's background queue re-ranks on
 * every swipe, and any parent re-render it caused used to walk straight
 * through to this subtree, re-rendering the poster of the card currently under
 * the user's finger mid-gesture.
 */
export const CardVisual = memo(
  CardVisualImpl,
  (prev, next) =>
    prev.item.id === next.item.id &&
    prev.runtimeMinutes === next.runtimeMinutes &&
    prev.parallax === next.parallax,
);

/** "2h 9m" / "48m" — compact enough for a metadata strip. */
function formatRuntime(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

function CardVisualImpl({
  item,
  runtimeMinutes,
  parallax,
}: {
  item: MediaItemRow;
  runtimeMinutes?: number | null;
  /** Horizontal drag in px. Drives the poster's counter-shift. */
  parallax?: SharedValue<number>;
}) {
  const t = useT();
  const genreLabel = useGenreLabel();

  /*
    THE ORIGINAL CARD, restored.

    For a while this was rebuilt to mirror another app: a 16:9 backdrop header,
    a separate content panel beneath it, and a small poster thumbnail straddling
    the seam. That is reverted. The card is once again a single full-bleed
    poster with its metadata laid over the bottom of the artwork.

    Why the poster is the right lead image here: this is a DECK. The judgement
    a person makes in the half-second before they swipe is almost entirely
    driven by the poster — it is the densest signal about tone and genre a film
    has, and it is the thing they recognise. Cropping it into a 16:9 letterbox
    and giving half the card to text inverted that: it turned a glance decision
    into a reading task, and shrank the artwork to a thumbnail at the exact
    moment it matters most.
  */
  const poster = imageUrl(item.poster_path, DECK_POSTER_SIZE);
  const runtime = formatRuntime(runtimeMinutes ?? item.runtime_minutes);

  // `item.genres` holds canonical ENGLISH keys — that is the storage contract
  // (src/i18n/genres.ts), so the card has to translate at render or a Hebrew
  // card face reads "Action, Thriller". Kept from the rebuild deliberately:
  // it is a translation fix, not part of the visual design that was reverted.
  const genres = item.genres.slice(0, 3).map((genre) => genreLabel(genre));

  // Counter-shift, clamped so the artwork can never travel past the overscan.
  // Predates the redesign (it arrived with the parallax/glass pass) and is kept.
  const parallaxStyle = useAnimatedStyle(() => {
    const drag = parallax?.value ?? 0;
    return {
      transform: [
        {
          translateX: interpolate(
            drag,
            [-260, 260],
            [PARALLAX_OVERSCAN, -PARALLAX_OVERSCAN],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  });

  return (
    <View
      className="flex-1 rounded-card overflow-hidden bg-card"
      // `shadow*` props are deprecated in RN 0.81; boxShadow works on the
      // New Architecture and on web. `elevation` remains the Android fallback.
      style={{ boxShadow: '0px 12px 28px rgba(0,0,0,0.55)', elevation: 12 }}
    >
      {/* ── The poster IS the card ──────────────────────────────────────── */}
      <Animated.View style={[styles.parallaxLayer, parallaxStyle]}>
        <Image
          source={poster ? { uri: poster } : undefined}
          style={StyleSheet.absoluteFillObject}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={180}
          recyclingKey={item.id}
          accessibilityIgnoresInvertColors
        />
      </Animated.View>
      <ContrastScrim />

      {/* Rating, top-end — where it sat before the rebuild. */}
      {item.vote_average != null && item.vote_average > 0 && (
        <View className="absolute top-4 end-4 bg-glass-strong rounded-full px-3 py-1.5">
          <AppText variant="label" className="text-txt">
            ★ {item.vote_average.toFixed(1)}
          </AppText>
        </View>
      )}

      {/* ── Metadata, laid over the artwork ─────────────────────────────── */}
      <View className="absolute bottom-0 start-0 end-0" style={{ padding: SPACE.card }}>
        <AppText variant="hero" numberOfLines={2} className="text-white">
          {item.title}
        </AppText>

        {/* Year · runtime. Plain text rather than icon pairs: over artwork the
            glyphs competed with the poster for attention and read as clutter. */}
        <View
          className="flex-row items-center flex-wrap"
          style={{ gap: SPACE.md, marginTop: SPACE.sm }}
        >
          {item.release_year != null && (
            <AppText variant="bodyStrong" className="text-white/85">
              {item.release_year}
            </AppText>
          )}
          {runtime && (
            <AppText variant="bodyStrong" className="text-white/85">
              {runtime}
            </AppText>
          )}
          <AppText variant="bodyStrong" className="text-white/85">
            {item.media_type === 'tv' ? t('deck.series') : t('deck.movie')}
          </AppText>
        </View>

        {/* Genre CHIPS, not a comma line — the pre-rebuild treatment. Filled
            glass, no stroke: the design separates surfaces with contrast and
            blur, and check-tokens.js rejects border utilities outright. */}
        {genres.length > 0 && (
          <View className="flex-row items-center flex-wrap" style={{ gap: SPACE.sm, marginTop: SPACE.md }}>
            {genres.map((genre) => (
              <View key={genre} className="bg-glass rounded-full px-3 py-1">
                <AppText variant="caption" className="text-white/90">
                  {genre}
                </AppText>
              </View>
            ))}
          </View>
        )}

        {item.overview && (
          <AppText
            variant="body"
            numberOfLines={3}
            className="text-white/75"
            style={{ marginTop: SPACE.md }}
          >
            {item.overview}
          </AppText>
        )}
      </View>
    </View>
  );
}

/**
 * The interactive top card.
 *
 * Memoised, and deliberately compared on `item.id` + `pendingAction` ONLY.
 * The parent re-renders whenever the fetch queue moves, and a plain shallow
 * compare would still fail on the inline `onSwipe`/`onOpenDetail` closures —
 * so the props that matter are named explicitly. The callbacks are also
 * `useCallback`-stable in the parent; this is belt and braces, because a
 * re-render here restarts the entry spring and visibly jolts the card.
 */
export const SwipeCard = memo(
  SwipeCardImpl,
  (prev, next) =>
    prev.item.id === next.item.id &&
    prev.pendingAction === next.pendingAction &&
    prev.runtimeMinutes === next.runtimeMinutes &&
    prev.interactionProgress === next.interactionProgress,
);

function SwipeCardImpl({
  item,
  transform,
  onSwipe,
  onOpenDetail,
  interactionProgress,
  entryFrom,
  pendingAction,
  onPendingHandled,
  onGestureActiveChange,
  runtimeMinutes,
}: SwipeCardProps) {
  const t = useT();
  const { width, height } = useWindowDimensions();
  const threshold = width * SWIPE_THRESHOLD_RATIO;

  const tx = transform.x;
  const ty = transform.y;
  const crossedThreshold = useSharedValue(0);
  /** Scale progress, on the same 0.92–1.0 curve the behind-card uses. */
  const entry = useSharedValue(entryFrom);

  // Captured once: this component is keyed by card id, so a given instance
  // only ever has one entry point. Reading the live prop instead would restart
  // the spring mid-life on an unrelated parent render — a visible jolt.
  const entryStart = useRef(entryFrom);

  useEffect(() => {
    // Slots are recycled, so a card must not inherit a translation left behind
    // by whatever used this slot last — e.g. a drag that was interrupted by a
    // filter change rather than finished by a swipe. Safe unconditionally: a
    // slot still carrying a live exit belongs to a ghost, and the deck has
    // already rotated this card onto a different one.
    tx.value = 0;
    ty.value = 0;

    entry.value = entryStart.current;
    entry.value = withSpring(1, { damping: 18, stiffness: 210, mass: 0.8 });
  }, [entry, item.id, tx, ty]);

  /**
   * Commits exactly once per card, IMMEDIATELY on gesture end.
   *
   * ── Why there is no delay here any more ────────────────────────────────
   * This used to hand the commit to `setTimeout(…, EXIT_DURATION)` so the card
   * could animate itself out before the deck advanced. The cost was 280ms of
   * dead time on every single swipe: the next card was already visible behind,
   * but this one still covered the whole stack (`StyleSheet.absoluteFill`) and
   * still owned the gesture detector — with `committed` already true, so every
   * touch in that window was swallowed. That is the "wait before you can swipe
   * again" and the jump that came with it.
   *
   * Now the deck advances on the same tick as the gesture, and the fly-out is
   * played by a detached ghost the parent renders (see ExitingCard) which is
   * `pointerEvents: none`. The animation is identical; it just no longer sits
   * between the user and the next card.
   */
  const committed = useRef(false);

  const commit = useCallback(
    (direction: SwipeDirection) => {
      if (committed.current) return;
      committed.current = true;

      if (direction === 'superlike') hapticHeavy();
      else if (direction === 'seen') hapticSelection();
      else hapticMedium();

      onSwipe(direction);
    },
    [onSwipe],
  );

  /**
   * The action-button equivalent of the gesture's inline exit.
   *
   * Runs on the JS thread (an effect), which is fine: assigning `withTiming`
   * to a shared value from JS still animates on the UI thread. The gesture
   * path deliberately does NOT call this — see the comment in `onEnd`.
   *
   * Either way the animation runs on deck-owned shared values, so when this
   * component unmounts a moment later the motion carries on uninterrupted in
   * the ghost, and `commit` is the last thing to happen rather than the first.
   */
  const launchExit = useCallback(
    (direction: SwipeDirection) => {
      const timing = { duration: EXIT_DURATION, easing: Easing.in(Easing.quad) };
      if (direction === 'superlike' || direction === 'seen') {
        // Vertical exits: up for the Watchlist, down for "already seen".
        tx.value = withTiming(tx.value * 0.4, { duration: EXIT_DURATION });
        ty.value = withTiming(direction === 'superlike' ? -height : height, timing);
      } else {
        // `direction` is LOGICAL; the physical side is direction × LIKE_AXIS.
        const physicalSign = (direction === 'like' ? 1 : -1) * LIKE_AXIS;
        ty.value = withTiming(ty.value + 48, { duration: EXIT_DURATION });
        tx.value = withTiming(physicalSign * width * 1.4, timing);
      }
      commit(direction);
    },
    [commit, height, tx, ty, width],
  );

  // Action-button swipes take the same path; theirs simply starts from rest
  // instead of from under a finger. Called from the JS thread here, which a
  // worklet supports — the `withTiming` assignments still animate on the UI
  // thread either way.
  useEffect(() => {
    if (!pendingAction) return;
    onPendingHandled();
    launchExit(pendingAction);
  }, [pendingAction, launchExit, onPendingHandled]);

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .activeOffsetY([-16, 16])
    .onBegin(() => {
      // Freeze the deck's visible stack for the duration of the drag.
      runOnJS(onGestureActiveChange)(true);
      runOnJS(hapticLight)();
    })
    .onFinalize(() => {
      // Fires on cancel as well as on end, so the lock can never be stranded.
      runOnJS(onGestureActiveChange)(false);
    })
    .onUpdate((event) => {
      tx.value = event.translationX;
      ty.value = event.translationY;

      const likeScore = event.translationX * LIKE_AXIS;
      const progress = Math.min(
        Math.max(Math.abs(likeScore), Math.abs(event.translationY)) / threshold,
        1,
      );
      interactionProgress.value = progress;

      const past =
        Math.abs(likeScore) > threshold || Math.abs(event.translationY) > threshold * 1.05;
      if (past && crossedThreshold.value === 0) {
        crossedThreshold.value = 1;
        runOnJS(hapticSelection)();
      } else if (!past && crossedThreshold.value === 1) {
        crossedThreshold.value = 0;
      }
    })
    .onEnd((event) => {
      const likeScore = event.translationX * LIKE_AXIS;
      const likeVelocity = event.velocityX * LIKE_AXIS;
      const up = -event.translationY;
      const down = event.translationY;
      const verticalDominant = Math.abs(event.translationY) > Math.abs(event.translationX);

      let direction: SwipeDirection | null = null;
      if (
        (up > threshold * 1.05 && verticalDominant) ||
        (event.velocityY < -VELOCITY_THRESHOLD && verticalDominant)
      ) {
        direction = 'superlike';
      } else if (
        (down > threshold * 1.05 && verticalDominant) ||
        (event.velocityY > VELOCITY_THRESHOLD && verticalDominant)
      ) {
        // Swipe down = "already seen it".
        direction = 'seen';
      } else if (likeScore > threshold || likeVelocity > VELOCITY_THRESHOLD) {
        direction = 'like';
      } else if (likeScore < -threshold || likeVelocity < -VELOCITY_THRESHOLD) {
        direction = 'dislike';
      }

      if (direction === null) {
        // Physics-based elasticity: spring back to rest.
        const spring = { damping: 16, stiffness: 180, mass: 0.7 };
        tx.value = withSpring(0, spring);
        ty.value = withSpring(0, spring);
        interactionProgress.value = withSpring(0, spring);
        crossedThreshold.value = 0;
        return;
      }

      /*
        The fly-out is started HERE, inline in the gesture worklet, and the JS
        thread is only told afterwards.

        Written out rather than delegated to a shared helper on purpose: a
        worklet calling another workletised closure depends on the Babel plugin
        having hoisted that closure correctly, and if it has not, the failure is
        a runtime throw on the UI thread that breaks every swipe. Inlining
        removes the question entirely. The action-button path uses `launchExit`
        for the same effect, but it runs on the JS thread where none of this
        applies.
      */
      const timing = { duration: EXIT_DURATION, easing: Easing.in(Easing.quad) };
      if (direction === 'superlike' || direction === 'seen') {
        tx.value = withTiming(tx.value * 0.4, { duration: EXIT_DURATION });
        ty.value = withTiming(direction === 'superlike' ? -height : height, timing);
      } else {
        const physicalSign = (direction === 'like' ? 1 : -1) * LIKE_AXIS;
        ty.value = withTiming(ty.value + 48, { duration: EXIT_DURATION });
        tx.value = withTiming(physicalSign * width * 1.4, timing);
      }
      runOnJS(commit)(direction);
    });

  const tap = Gesture.Tap()
    .maxDuration(260)
    .maxDistance(10)
    .onEnd((_event, success) => {
      if (success) runOnJS(onOpenDetail)();
    });

  const gesture = Gesture.Exclusive(pan, tap);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      // Same 0.92→1.0 curve the behind-card sits on, so a promoted card
      // continues its scale instead of restarting it.
      { scale: 0.92 + 0.08 * entry.value },
      {
        // Rotation follows the PHYSICAL finger direction (visual physics),
        // while like/dislike semantics stay logical via LIKE_AXIS above.
        rotate: `${interpolate(
          tx.value,
          [-width, 0, width],
          [-12, 0, 12],
          Extrapolation.CLAMP,
        )}deg`,
      },
    ],
  }));

  const likeBadgeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      tx.value * LIKE_AXIS,
      [threshold * 0.25, threshold],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  const nopeBadgeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      -tx.value * LIKE_AXIS,
      [threshold * 0.25, threshold],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  const superBadgeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      -ty.value,
      [threshold * 0.3, threshold * 1.05],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  const seenBadgeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      ty.value,
      [threshold * 0.3, threshold * 1.05],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  return (
    <GestureDetector gesture={gesture}>
      {/* NOTE: Reanimated 4 removed the experimental sharedTransitionTag API;
          the poster→detail handoff now relies on the stack's fade animation.

          IMPORTANT: NativeWind `className` is NOT applied to Reanimated's
          Animated.View — layout set that way is silently dropped (which
          collapsed this card to height 0 on web). Every Animated.View here
          carries explicit styles; NativeWind classes live on plain Views. */}
      <Animated.View style={[StyleSheet.absoluteFill, cardStyle]}>
        <CardVisual item={item} runtimeMinutes={runtimeMinutes} parallax={tx} />

        {/* LIKE sits on the logical START side (mirrors under RTL). */}
        <Animated.View style={[styles.badgeStart, likeBadgeStyle]}>
          <View className="bg-like rounded-2xl px-5 py-2.5">
            <AppText variant="title" className="text-app">
              {t('deck.like')}
            </AppText>
          </View>
        </Animated.View>

        <Animated.View style={[styles.badgeEnd, nopeBadgeStyle]}>
          <View className="bg-nope rounded-2xl px-5 py-2.5">
            <AppText variant="title" className="text-white">
              {t('deck.nope')}
            </AppText>
          </View>
        </Animated.View>

        <Animated.View style={[styles.badgeBottom, superBadgeStyle]}>
          <View className="bg-olive rounded-2xl px-5 py-2.5">
            <AppText variant="title" className="text-like">
              {t('deck.watchlist')}
            </AppText>
          </View>
        </Animated.View>

        {/* Swipe DOWN — "already seen it". */}
        <Animated.View style={[styles.badgeTop, seenBadgeStyle]}>
          <View className="bg-txt-secondary rounded-2xl px-5 py-2.5">
            <AppText variant="title" className="text-app">
              {t('deck.seen')}
            </AppText>
          </View>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * The fly-out, decoupled from the deck.
 *
 * This exists so a swipe can be committed instantly. The card it draws has
 * already left the deck — it is not the top card, it holds no gesture and it
 * is `pointerEvents: none`, so the freshly promoted card underneath is
 * touchable the moment it appears. Several of these can legitimately be in the
 * air at once when someone swipes quickly, which is why each carries its own
 * id.
 */
export const ExitingCard = memo(ExitingCardImpl, (prev, next) => prev.exit.id === next.exit.id);

function ExitingCardImpl({ exit }: { exit: CardExit }) {
  const { width } = useWindowDimensions();

  /*
    No animation is started here — it is already in flight.

    These are the very shared values the live card was using, still running the
    `withTiming` that its gesture kicked off on the UI thread. Adopting them
    means this component renders a card that is ALREADY mid-exit, wherever the
    animation has got to, rather than resetting it to the release point and
    replaying it. That is what makes the hand-off invisible: React's work
    happens somewhere in the middle of a motion that never paused for it.

    This component then never touches React again — memoised on `exit.id`, and
    the parent prunes it inside the state update it was already doing for the
    next swipe.
  */
  const tx = exit.transform.x;
  const ty = exit.transform.y;

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      {
        rotate: `${interpolate(
          tx.value,
          [-width, 0, width],
          [-12, 0, 12],
          Extrapolation.CLAMP,
        )}deg`,
      },
    ],
  }));

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <CardVisual item={exit.item} />
    </Animated.View>
  );
}
