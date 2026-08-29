import { Linking, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { safeFireAndForget } from '@/lib/safeNative';
import { useT } from '@/i18n';

const TMDB_URL = 'https://www.themoviedb.org/';

/**
 * TMDB's brand gradient, used for the wordmark plate.
 * Sampled from their published logo; do not restyle to the app's accent — the
 * point of an attribution is that it reads as THEIR mark, not ours.
 */
const TMDB_GRADIENT = ['#90CEA1', '#01B4E4'] as const;

/**
 * Required TMDB API attribution.
 *
 * ── Why this is not optional ───────────────────────────────────────────────
 * TMDB's API terms require an app using their data to display the attribution
 * statement and their branding. Every title, poster, rating and provider row in
 * this app comes from TMDB, so the notice has to be somewhere the user can
 * actually reach — it lives on Profile and on both legal documents rather than
 * buried behind a paywall or a sign-in.
 *
 * The statement is localised (see `legal.attribution` in en.ts / he.ts). The
 * Hebrew rendering is the translation of TMDB's exact wording, shown because a
 * Hebrew-first UI displaying an English-only legal line is not meaningfully
 * "displaying" it to that reader.
 */
export function TmdbAttribution() {
  const t = useT();

  return (
    <PressableScale
      onPress={() =>
        safeFireAndForget('Linking.openURL(tmdb)', () => Linking.openURL(TMDB_URL))
      }
      haptic="selection"
      activeScale={0.98}
      accessibilityRole="link"
      accessibilityLabel={`${t('legal.attribution')} ${t('legal.tmdbVisit')}`}
      style={{
        gap: 12,
        borderRadius: 20,
        backgroundColor: '#121826',
        paddingHorizontal: 18,
        paddingVertical: 18,
        alignItems: 'center',
      }}
    >
      {/* Wordmark plate. An image asset would be the ideal mark, but a bundled
          logo file is a licensing artefact this repo does not carry — the
          gradient plate keeps TMDB's identity without shipping their PNG. */}
      <LinearGradient
        colors={TMDB_GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{
          borderRadius: 7,
          paddingHorizontal: 14,
          paddingVertical: 7,
        }}
      >
        <AppText
          variant="bodyStrong"
          style={{ color: '#0D253F', letterSpacing: 1.5 }}
          // Latin mark: never mirrored, even under RTL.
          allowFontScaling={false}
        >
          TMDB
        </AppText>
      </LinearGradient>

      <AppText variant="caption" className="text-center text-txt-secondary">
        {t('legal.attribution')}
      </AppText>

      <AppText variant="caption" style={{ color: '#01B4E4' }}>
        {t('legal.tmdbVisit')}
      </AppText>
    </PressableScale>
  );
}
