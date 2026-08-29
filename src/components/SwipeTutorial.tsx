import { View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { useT, type TranslationKey } from '@/i18n';
import { C } from '@/theme/tokens';

interface Hint {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  gesture: TranslationKey;
  meaning: TranslationKey;
}

const HINTS: Hint[] = [
  { icon: 'arrow-forward', color: '#00B8D9', gesture: 'tutorial.right', meaning: 'tutorial.rightMeaning' },
  { icon: 'arrow-back', color: '#E8503F', gesture: 'tutorial.left', meaning: 'tutorial.leftMeaning' },
  { icon: 'arrow-up', color: '#A78BFA', gesture: 'tutorial.up', meaning: 'tutorial.upMeaning' },
  { icon: 'arrow-down', color: '#94A3B8', gesture: 'tutorial.down', meaning: 'tutorial.downMeaning' },
];

/**
 * First-run gesture guide, shown over the deck until dismissed.
 *
 * The horizontal arrows are intentionally NOT mirrored for RTL: they describe
 * the physical direction to move a finger, and the like-axis already flips in
 * SwipeCard, so "→ = Like" stays literally true in both layouts.
 */
export function SwipeTutorial({ onDismiss }: { onDismiss: () => void }) {
  const t = useT();

  return (
    <View
      className="absolute items-center justify-center px-7"
      style={{ top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.82)' }}
    >
      <GlassView className="rounded-sheet w-full p-6 gap-5">
        <View className="gap-1">
          <AppText variant="title">{t('tutorial.title')}</AppText>
          <AppText variant="body">{t('tutorial.subtitle')}</AppText>
        </View>

        <View className="gap-3.5">
          {HINTS.map((hint) => (
            <View key={hint.gesture} className="flex-row items-center gap-3">
              <View
                className="w-10 h-10 rounded-full items-center justify-center"
                // Was a 2pt ring in hint.color on a navy disc. Same read, no stroke:
                // the disc takes a wash of the gesture colour and the glyph
                // stays fully saturated on top of it.
                style={{ backgroundColor: `${hint.color}24` }}
              >
                <Ionicons name={hint.icon} size={19} color={hint.color} />
              </View>
              <View className="flex-1">
                <AppText variant="bodyStrong" style={{ color: hint.color }}>
                  {t(hint.gesture)}
                </AppText>
                <AppText variant="caption">{t(hint.meaning)}</AppText>
              </View>
            </View>
          ))}
        </View>

        <PressableScale
          onPress={onDismiss}
          haptic="success"
          accessibilityRole="button"
          style={{
            backgroundColor: '#00B8D9',
            borderRadius: 999,
            paddingVertical: 14,
            alignItems: 'center',
          }}
        >
          <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
            {t('tutorial.gotIt')}
          </AppText>
        </PressableScale>
      </GlassView>
    </View>
  );
}
