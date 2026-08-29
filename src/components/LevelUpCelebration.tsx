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
import { levelNameKey } from '@/lib/quests';
import { useT, type TranslationKey } from '@/i18n';

/**
 * Level-up moment.
 *
 * Shares the celebration primitives with the Duo match and streak overlays,
 * including the completion backstop — if the frame ticker never runs, a timer
 * forces the final state so the card is readable and the dismiss button is
 * tappable rather than sitting at scale 0. See Celebration.tsx.
 */
export function LevelUpCelebration({
  level,
  onDismiss,
}: {
  level: number;
  onDismiss: () => void;
}) {
  const t = useT();
  const { width, height } = useWindowDimensions();
  const progress = useCelebrationProgress(true, 1500);

  const card = popScale(easeBack(Math.min(progress / 0.6, 1)), 0.92);
  const actions = 0.6 + 0.4 * easeOut(Math.min(Math.max((progress - 0.5) / 0.5, 0), 1));

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={t('level.up', { level })}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 42,
      }}
    >
      <LinearGradient
        colors={['rgba(13,13,18,0.92)', 'rgba(28,16,48,0.96)', 'rgba(13,13,18,0.98)']}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />

      <View style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Shockwave progress={progress} color="#A78BFA" maxSize={Math.min(width, 360)} />
        <Burst
          progress={progress}
          radius={Math.min(width * 0.36, 160)}
          count={18}
          colors={['#A78BFA', '#FBBF24', '#00B8D9']}
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
        <Ionicons name="ribbon" size={54} color="#FBBF24" />
        <AppText variant="hero" className="text-white text-center">
          {t('level.up', { level })}
        </AppText>
        <AppText variant="subtitle" className="text-center" style={{ color: '#C4B5FD' }}>
          {t(levelNameKey(level) as TranslationKey)}
        </AppText>
        <AppText variant="body" className="text-center text-txt-secondary">
          {t('level.upBody')}
        </AppText>

        <PressableScale
          onPress={onDismiss}
          haptic="medium"
          accessibilityRole="button"
          style={{
            marginTop: 8,
            backgroundColor: '#A78BFA',
            borderRadius: 999,
            paddingHorizontal: 40,
            paddingVertical: 14,
            opacity: actions,
          }}
        >
          <AppText variant="bodyStrong" className="text-white">
            {t('level.continue')}
          </AppText>
        </PressableScale>
      </View>
    </View>
  );
}
