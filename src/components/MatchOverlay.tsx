import { View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import {
  Burst,
  Shockwave,
  easeBack,
  easeOut,
  popScale,
  useCelebrationProgress,
} from '@/components/Celebration';
import { imageUrl } from '@/lib/tmdb';
import type { DuoCard } from '@/lib/duoTransport';
import { useT } from '@/i18n';
import { C, R, SPACE } from '@/theme/tokens';

/**
 * Full-screen "It's a Match!" moment.
 *
 * This is the payoff of the entire Duo feature, so it deliberately takes over
 * the screen rather than appearing as a toast: two people who just agreed on
 * something should both look up from their phones.
 *
 * Everything animates off one state-driven `progress` value (see
 * Celebration.tsx for why it is not Reanimated or Lottie), and the poster is
 * rendered at a FIXED pixel size — percentage heights against an
 * aspect-ratio-derived parent resolve to `auto` in Yoga and blow the image up
 * to its intrinsic resolution on device.
 */
export function MatchOverlay({
  card,
  onDismiss,
  onKeepSwiping,
}: {
  card: DuoCard;
  onDismiss: () => void;
  onKeepSwiping?: () => void;
}) {
  const t = useT();
  const { width, height } = useWindowDimensions();
  const progress = useCelebrationProgress(true, 1500);

  const posterWidth = Math.min(width * 0.46, 210);
  const posterHeight = Math.round(posterWidth * 1.5);

  // Staged so the beats land in sequence rather than all at once:
  // shockwave → poster pop → headline → actions.
  //
  // Every one of these is mapped through popScale / clamped opacity so the
  // overlay is READABLE AND DISMISSIBLE at progress 0. The particles and the
  // shockwave are the only things that genuinely start from nothing, because
  // they are decoration — if the ticker never runs they simply don't appear,
  // and nothing the user needs is lost.
  const headline = popScale(easeBack(Math.min(Math.max((progress - 0.18) / 0.5, 0), 1)));
  const posterScale = popScale(easeBack(Math.min(progress / 0.55, 1)), 0.94);
  // Never below 1 for the action row: this holds the only way out of the
  // overlay, so it can never be faded out by a stalled animation.
  const actions = 0.6 + 0.4 * easeOut(Math.min(Math.max((progress - 0.55) / 0.45, 0), 1));

  const poster = imageUrl(card.poster_path, 'w500');

  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      accessibilityRole="alert"
      accessibilityLabel={t('duo.matchTitle')}
    >
      {/* Scrim. Opaque enough that the deck underneath cannot compete. */}
      {/*
        A designed three-stop wash rather than a flat token fill: the warm
        middle stop is what makes the moment feel like a celebration instead
        of a modal. Kept as literals for that reason.
      */}
      <LinearGradient
        colors={['rgba(13,13,18,0.94)', 'rgba(40,8,24,0.97)', 'rgba(13,13,18,0.99)']}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />

      <View style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Shockwave progress={progress} maxSize={Math.min(width * 1.1, 440)} />
        <Burst progress={progress} radius={Math.min(width * 0.42, 190)} count={20} />
      </View>

      <View style={{ alignItems: 'center', gap: SPACE.lg, paddingHorizontal: SPACE.xxl }}>
        <View
          style={{
            width: posterWidth,
            height: posterHeight,
            borderRadius: R.card,
            overflow: 'hidden',
            backgroundColor: C.surface,
            boxShadow: `0px 18px 48px ${C.accentGlow}`,
            elevation: 16,
            transform: [{ scale: posterScale }],
          }}
        >
          {poster && (
            <Image
              source={{ uri: poster }}
              style={{ width: posterWidth, height: posterHeight }}
              contentFit="cover"
              transition={0}
              cachePolicy="memory-disk"
            />
          )}
        </View>

        <View style={{ alignItems: 'center', gap: SPACE.sm, transform: [{ scale: headline }] }}>
          <View className="flex-row items-center gap-2">
            {/*
              Accent, not the deck green. These hearts are CELEBRATION chrome,
              not a yes/no control — the verdict colours stay reserved for the
              vote discs, where they carry meaning.
            */}
            <Ionicons name="heart" size={26} color={C.accent} />
            <AppText variant="hero">{t('duo.matchTitle')}</AppText>
            <Ionicons name="heart" size={26} color={C.accent} />
          </View>
          <AppText variant="bodyStrong" numberOfLines={2} className="text-center">
            {card.title}
          </AppText>
          {/* Explicit style: `text-txt-secondary` would lose to the caption
              variant's own `text-txt-tertiary` on emission order. */}
          <AppText variant="caption" className="text-center" style={{ color: C.textSecondary }}>
            {t('duo.matchBody')}
          </AppText>
        </View>

        <View style={{ width: '100%', gap: SPACE.md, opacity: actions }}>
          <PressableScale
            onPress={onKeepSwiping ?? onDismiss}
            haptic="medium"
            accessibilityRole="button"
            style={{
              backgroundColor: C.accent,
              borderRadius: R.pill,
              paddingVertical: SPACE.lg,
              alignItems: 'center',
            }}
          >
            <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
              {t('duo.keepSwiping')}
            </AppText>
          </PressableScale>
        </View>
      </View>
    </View>
  );
}
