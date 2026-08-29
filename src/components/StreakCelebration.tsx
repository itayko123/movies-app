import { View, useWindowDimensions } from 'react-native';
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
import { useT } from '@/i18n';

/**
 * Milestone celebration for the swipe streak.
 *
 * Shares the celebration primitives with the Duo match overlay, including the
 * completion backstop — so if the frame ticker is throttled the user still gets
 * a readable, dismissible card rather than an invisible one. See
 * Celebration.tsx.
 */
export function StreakCelebration({
  days,
  onDismiss,
}: {
  days: number;
  onDismiss: () => void;
}) {
  const t = useT();
  const { width, height } = useWindowDimensions();
  const progress = useCelebrationProgress(true, 1400);

  const card = popScale(easeBack(Math.min(progress / 0.6, 1)), 0.92);
  const actions = 0.6 + 0.4 * easeOut(Math.min(Math.max((progress - 0.5) / 0.5, 0), 1));

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={t('streak.milestone', { count: days })}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 40,
      }}
    >
      <LinearGradient
        colors={['rgba(13,13,18,0.92)', 'rgba(38,20,4,0.96)', 'rgba(13,13,18,0.98)']}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />

      <View style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Shockwave progress={progress} color="#FBBF24" maxSize={Math.min(width, 360)} />
        <Burst
          progress={progress}
          radius={Math.min(width * 0.36, 160)}
          count={16}
          colors={['#FBBF24', '#00B8D9', '#FB923C']}
        />
      </View>

      <View
        style={{
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 34,
          transform: [{ scale: card }],
        }}
      >
        <Ionicons name="flame" size={54} color="#FBBF24" />
        <AppText variant="hero" className="text-white text-center">
          {t('streak.milestone', { count: days })}
        </AppText>
        <AppText variant="body" className="text-center text-txt-secondary">
          {t('streak.milestoneBody')}
        </AppText>

        <PressableScale
          onPress={onDismiss}
          haptic="medium"
          accessibilityRole="button"
          style={{
            marginTop: 8,
            backgroundColor: '#FBBF24',
            borderRadius: 999,
            paddingHorizontal: 40,
            paddingVertical: 14,
            opacity: actions,
          }}
        >
          <AppText variant="bodyStrong" style={{ color: '#000000' }}>
            {t('streak.keepGoing')}
          </AppText>
        </PressableScale>
      </View>
    </View>
  );
}
