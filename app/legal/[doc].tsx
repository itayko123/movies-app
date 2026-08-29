import { I18nManager, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { TmdbAttribution } from '@/components/TmdbAttribution';
import { C } from '@/theme/tokens';
import { useT, type TranslationKey } from '@/i18n';

type Doc = 'privacy' | 'terms';

const DOCS: Record<Doc, { title: TranslationKey; body: TranslationKey }> = {
  privacy: { title: 'legal.privacyTitle', body: 'legal.privacyBody' },
  terms: { title: 'legal.termsTitle', body: 'legal.termsBody' },
};

/**
 * Privacy Policy / Terms of Use, rendered from i18n so both languages stay in
 * one place.
 *
 * ── The copy is a DRAFT and says so ────────────────────────────────────────
 * Shipping plausible-looking legal text that nobody reviewed is worse than
 * shipping none: it reads as binding to the user and as done to the developer.
 * The banner at the top makes the status unmissable, and it is the one thing
 * to delete once real reviewed copy lands.
 */
export default function LegalScreen() {
  const t = useT();
  const router = useRouter();
  const { doc } = useLocalSearchParams<{ doc?: string }>();

  // Unknown slug falls back to the privacy policy rather than rendering an
  // empty screen — this route is only ever reached from two fixed links.
  const key: Doc = doc === 'terms' ? 'terms' : 'privacy';
  const entry = DOCS[key];

  /**
   * Blank lines separate blocks; a leading `##` marks a section heading.
   *
   * The marker keeps each document as ONE translation string. The alternative
   * — a key per heading and a key per paragraph — turns a nine-section policy
   * into forty keys that must stay perfectly parallel across two locales, and
   * the first time someone adds a section to one language only, the other
   * renders a document with a hole in it.
   */
  const blocks = t(entry.body)
    .split('\n\n')
    .map((raw) => {
      const text = raw.trim();
      return text.startsWith('##')
        ? { heading: true, text: text.replace(/^##\s*/, '') }
        : { heading: false, text };
    })
    .filter((block) => block.text.length > 0);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1 }}>
      <View
        className="flex-row items-center gap-3"
        style={{ paddingHorizontal: 20, paddingBottom: 8 }}
      >
        <PressableScale
          onPress={() => router.back()}
          haptic="selection"
          activeScale={0.88}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: C.surface,
          }}
        >
          {/*
            `chevron-back` is a directional glyph: it must point at the screen
            the user came from, which is the opposite side under RTL — and
            Ionicons will not flip it for us. The comment above this line said
            exactly that for months while applying no transform at all.
          */}
          <Ionicons
            name="chevron-back"
            size={18}
            color={C.text}
            style={I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined}
          />
        </PressableScale>
        <AppText variant="title" numberOfLines={1} className="flex-1">
          {t(entry.title)}
        </AppText>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: 60,
          gap: 18,
          width: '100%',
          maxWidth: 640,
          alignSelf: 'center',
        }}
        showsVerticalScrollIndicator={false}
      >
        <View
          className="flex-row items-center gap-2.5"
          style={{
            borderRadius: 14,
            backgroundColor: 'rgba(250,204,21,0.10)',
            paddingHorizontal: 14,
            paddingVertical: 12,
          }}
        >
          <Ionicons name="warning-outline" size={16} color="#FBBF24" />
          <AppText variant="caption" className="flex-1" style={{ color: '#FBBF24' }}>
            {t('legal.draftNotice')}
          </AppText>
        </View>

        {blocks.map((block, index) =>
          block.heading ? (
            <AppText
              // Index is in the key ONLY as a tiebreaker alongside the text —
              // two sections can legitimately share an opening phrase.
              key={`h-${index}-${block.text.slice(0, 24)}`}
              variant="subtitle"
              // Extra space above, tight below: a heading belongs to the
              // paragraph that follows it, not the one before.
              style={{ marginTop: index === 0 ? 0 : 10, marginBottom: -6 }}
            >
              {block.text}
            </AppText>
          ) : (
            <AppText key={`p-${index}-${block.text.slice(0, 24)}`} variant="body">
              {block.text}
            </AppText>
          ),
        )}

        <TmdbAttribution />
      </ScrollView>
    </SafeAreaView>
  );
}
