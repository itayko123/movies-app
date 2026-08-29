import { useEffect } from 'react';
import { I18nManager, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { AnimatedLogo } from '@/components/AnimatedLogo';
import { ConcentricRings } from '@/components/ConcentricRings';
import { CinematicGlow } from '@/components/CinematicGlow';
import { PosterWall } from '@/components/PosterWall';
import { useWallPosters } from '@/hooks/useWallPosters';
import { BLUR, C, R, SHADOW, SPACE } from '@/theme/tokens';
import { useT } from '@/i18n';

/**
 * Fades + rises its children once, on a delay. Used to cascade the headline,
 * tagline and CTA in after the logo has settled, so the screen assembles
 * itself instead of appearing all at once.
 */
function Rise({
  delay,
  children,
}: {
  delay: number;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  // Starts VISIBLE wherever motion can't run (web is inert here; reduced-motion
  // users opted out). Fading in from 0 on an inert platform would leave the
  // whole welcome screen blank — see the note in AnimatedLogo.
  const inert = Platform.OS === 'web' || reduceMotion;
  const progress = useSharedValue(inert ? 1 : 0);

  useEffect(() => {
    if (inert) return;
    progress.value = withDelay(
      delay,
      withTiming(1, { duration: 620, easing: Easing.out(Easing.cubic) }),
    );
  }, [progress, delay, inert]);

  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 18 }],
  }));

  return <Animated.View style={style}>{children}</Animated.View>;
}

/**
 * Welcome / animated splash.
 *
 * Shown to signed-out users before /auth. The native splash is a flat black
 * screen (app.config.js) and this screen's background is the same black, so
 * when SplashScreen.hideAsync() fires there is no colour step — the logo simply
 * settles in and the rings begin to breathe. That is the whole trick to the
 * handoff feeling continuous rather than like two separate screens.
 */
export default function WelcomeScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wallPosters = useWallPosters();

  return (
    <View className="flex-1 bg-app">
      {/*
        CINEMATIC BACKDROP, in four layers back-to-front.

        Flat black read as "unfinished" on device, so the screen now sits on
        real movie artwork — but heavily defocused, so it is atmosphere rather
        than content competing with the logo.

        1. the same slowly-scrolling poster montage as the login wall
        2. a heavy blur, turning it into drifting colour
        3. a deep cinematic wash (navy → black) plus an accent bloom
        4. the breathing ring field
      */}
      <PosterWall posters={wallPosters} />

      <BlurView
        intensity={Platform.OS === 'android' ? 30 : BLUR.medium}
        tint="dark"
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
        pointerEvents="none"
      />

      {/*
        Held DELIBERATELY light (0.42, was 0.80). At 0.80 the posters were
        technically present but crushed to near-black — which is exactly why
        the screen still read as "a black screen with a logo". The artwork has
        to survive this layer for the backdrop to feel alive.
      */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: 'rgba(6,10,20,0.42)',
        }}
      />

      {/* Drifting warm + cool lights — the layer that makes it feel lit. */}
      <CinematicGlow />

      {/* Breathing ring field, centred behind the logo. */}
      <ConcentricRings color="rgba(0,184,217,0.22)" />

      {/* Vignette. Top stays open so the warm key light survives; only the
          bottom darkens, to seat the CTA. */}
      <LinearGradient
        colors={['rgba(0,0,0,0.30)', 'transparent', 'rgba(0,0,0,0.72)']}
        locations={[0, 0.42, 1]}
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
        pointerEvents="none"
      />

      <View
        className="flex-1 items-center justify-center"
        style={{
          paddingHorizontal: SPACE.xxl,
          paddingTop: insets.top,
          paddingBottom: insets.bottom + SPACE.section,
        }}
      >
        <AnimatedLogo size={230} />

        <View className="items-center" style={{ marginTop: SPACE.section }}>
          <Rise delay={260}>
            <AppText variant="label" className="text-txt-secondary text-center">
              {t('welcome.eyebrow')}
            </AppText>
          </Rise>

          <Rise delay={380}>
            <AppText
              variant="hero"
              className="text-center"
              style={{ marginTop: SPACE.sm, color: C.accent }}
            >
              {t('welcome.title')}
            </AppText>
          </Rise>

          <Rise delay={500}>
            <AppText
              variant="body"
              className="text-center"
              style={{ marginTop: SPACE.md, maxWidth: 300 }}
            >
              {t('welcome.tagline')}
            </AppText>
          </Rise>
        </View>
      </View>

      {/* CTA pinned to the bottom third, like the reference. */}
      <View
        className="absolute start-0 end-0 items-center"
        style={{ bottom: insets.bottom + SPACE.section, paddingHorizontal: SPACE.xxl }}
      >
        <Rise delay={640}>
          <PressableScale
            onPress={() => router.push('/auth')}
            haptic="medium"
            accessibilityRole="button"
            accessibilityLabel={t('welcome.cta')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: SPACE.md,
              borderRadius: R.pill,
              paddingHorizontal: SPACE.section,
              paddingVertical: SPACE.lg,
              backgroundColor: C.accent,
              ...SHADOW.accent,
            }}
          >
            <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
              {t('welcome.cta')}
            </AppText>
            {/* Arrow points along the reading direction; Ionicons does not
                mirror direction-carrying glyphs on its own, so RTL flips it. */}
            <Ionicons
              name="arrow-forward"
              size={18}
              color={C.onAccent}
              style={I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined}
            />
          </PressableScale>
        </Rise>
      </View>
    </View>
  );
}
