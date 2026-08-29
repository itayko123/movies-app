import { useEffect } from 'react';
import { View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { useT, type TranslationKey } from '@/i18n';
import { C, R, SHADOW, SPACE } from '@/theme/tokens';

interface Step {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  title: TranslationKey;
  body: TranslationKey;
}

const STEPS: Step[] = [
  { icon: 'link', color: C.accent, title: 'duo.step1', body: 'duo.step1Body' },
  // Violet is the DUO affordance colour per tokens.ts — the middle step is
  // the one that is actually ABOUT the pairing, so it carries it.
  { icon: 'swap-horizontal', color: C.secondary, title: 'duo.step2', body: 'duo.step2Body' },
  { icon: 'sparkles', color: C.accent, title: 'duo.step3', body: 'duo.step3Body' },
];

/**
 * One step, sliding up and fading in on a stagger.
 *
 * NOTE: the animation drives `opacity` from a shared value that starts at 0 but
 * is pushed to 1 in an effect — deliberately NOT a Reanimated `entering`
 * animation. Layout animations hide the element until they run, and Reanimated
 * is inert under react-native-web here, which would leave the whole explainer
 * permanently invisible on web. Driving it ourselves means the worst case is
 * "appears without animating" rather than "never appears".
 */
function StepRow({ step, index }: { step: Step; index: number }) {
  const t = useT();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      120 * index,
      withSpring(1, { damping: 16, stiffness: 180, mass: 0.7 }),
    );
  }, [progress, index]);

  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: 18 * (1 - progress.value) }],
  }));

  return (
    <Animated.View style={style}>
      <View className="flex-row items-start gap-3.5">
        <View
          className="items-center justify-center rounded-2xl"
          style={{
            width: 44,
            height: 44,
            // Alpha-tinted fill of the step's own colour — the established
            // pattern for icon chips, and it keeps the no-borders rule.
            backgroundColor: `${step.color}22`,
          }}
        >
          <Ionicons name={step.icon} size={20} color={step.color} />
        </View>
        <View className="flex-1">
          <AppText variant="bodyStrong">{t(step.title)}</AppText>
          <AppText variant="caption" className="mt-0.5">
            {t(step.body)}
          </AppText>
        </View>
      </View>
    </Animated.View>
  );
}

/**
 * Animated explainer shown before the first Duo session.
 *
 * Duo was previously a bare "Start a Duo session" button with no indication of
 * what it did, who the partner was, or what would happen next — which is why it
 * read as confusing rather than inviting.
 */
export function DuoIntro({ onStart }: { onStart: () => void }) {
  const t = useT();
  const glow = useSharedValue(0);

  useEffect(() => {
    glow.value = withTiming(1, { duration: 700 });
  }, [glow]);

  const heroStyle = useAnimatedStyle(() => ({
    opacity: glow.value,
    transform: [{ scale: 0.9 + 0.1 * glow.value }],
  }));

  return (
    <View className="flex-1 justify-center px-2 gap-6">
      <Animated.View style={heroStyle}>
        <View className="items-center gap-3">
          <View
            className="items-center justify-center rounded-full"
            style={{
              width: 76,
              height: 76,
              backgroundColor: C.accentSoft,
              ...SHADOW.accent,
            }}
          >
            <Ionicons name="people" size={34} color={C.accent} />
          </View>
          <AppText variant="title" className="text-center">
            {t('duo.introTitle')}
          </AppText>
          <AppText variant="body" className="text-center px-4">
            {t('duo.introBody')}
          </AppText>
        </View>
      </Animated.View>

      <GlassView className="rounded-3xl p-5 gap-5">
        {STEPS.map((step, index) => (
          <StepRow key={step.title} step={step} index={index} />
        ))}
      </GlassView>

      <PressableScale
        onPress={onStart}
        haptic="success"
        accessibilityRole="button"
        style={{
          backgroundColor: C.accent,
          borderRadius: R.pill,
          paddingVertical: SPACE.lg,
          alignItems: 'center',
          ...SHADOW.accent,
        }}
      >
        <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
          {t('duo.create')}
        </AppText>
      </PressableScale>
    </View>
  );
}
