import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  I18nManager,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type TextStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { GlassView } from '@/components/GlassView';
import { PressableScale } from '@/components/PressableScale';
import { PosterRowSkeleton } from '@/components/Skeleton';
import { MoodBubble } from '@/components/MoodBubble';
import { useMoodSearch } from '@/hooks/useMoodSearch';
import { hapticSelection } from '@/lib/haptics';
import { useT } from '@/i18n';
import { useAppStore } from '@/state/store';

/** Height of the glass tab bar the composer must clear. */
const TAB_BAR_HEIGHT = Platform.OS === 'ios' ? 84 : 68;

/** `outlineStyle` is a web-only CSS property with no React Native equivalent. */
const WEB_INPUT_RESET =
  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : undefined;

export default function MoodScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isPremium = useAppStore((s) => s.isPremium);
  const { messages, isThinking, send, rateLimited } = useMoodSearch();

  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList>(null);

  /**
   * Pending scroll frame, cancelled on unmount.
   *
   * Submitting and immediately switching tabs otherwise leaves a callback
   * queued against a list that no longer exists. The optional chain kept that
   * from throwing, but the frame was still scheduled and the closure still held
   * the ref alive — and this screen is one of the three the user flips between
   * fastest, so it is worth cancelling rather than relying on the guard.
   */
  const scrollFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (scrollFrame.current != null) cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );

  const submit = (text?: string) => {
    const query = (text ?? draft).trim();
    if (query.length < 2 || isThinking) return;
    hapticSelection();
    Keyboard.dismiss();
    send(query);
    setDraft('');
    if (scrollFrame.current != null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      listRef.current?.scrollToEnd({ animated: true });
    });
  };

  const canSubmit = draft.trim().length >= 2 && !isThinking;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1 }}>
      {/*
       * iOS pushes content above the keyboard with `padding`; Android already
       * resizes the window via adjustResize, where `padding` would double-count
       * and leave a gap. The offset accounts for the translucent tab bar that
       * sits under this screen.
       */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        /*
         * NEGATIVE offset, and that is not a typo.
         *
         * `padding` inserts space equal to the keyboard height MINUS this
         * offset. The composer already reserves TAB_BAR_HEIGHT of bottom
         * padding for the translucent tab bar, so the previous positive offset
         * double-counted that space and shoved the whole conversation upward —
         * the "jumping to the top of the screen" the client saw. Subtracting
         * the padding the composer already owns lands the input just above the
         * keyboard instead.
         */
        keyboardVerticalOffset={Platform.OS === 'ios' ? -(TAB_BAR_HEIGHT - insets.bottom) : 0}
      >
        {/* Header */}
        <View className="px-5 pb-3 flex-row items-center justify-between">
          <View className="flex-1">
            <AppText variant="title">{t('mood.title')}</AppText>
            <AppText variant="caption" className="mt-0.5">
              {t('mood.subtitle')}
            </AppText>
          </View>
          {!isPremium && (
            <PressableScale
              onPress={() => router.push('/paywall')}
              haptic="light"
              activeScale={0.92}
              accessibilityRole="button"
              style={{
                backgroundColor: 'rgba(0,184,217,0.16)',
                borderRadius: 999,
                paddingHorizontal: 16,
                paddingVertical: 8,
              }}
            >
              <AppText variant="caption" className="text-brand">
                {t('common.upgrade')}
              </AppText>
            </PressableScale>
          )}
        </View>

        {/* Conversation. Tapping anywhere in the empty space dismisses the
            keyboard; `keyboardShouldPersistTaps="handled"` keeps the example
            chips and result cards tappable while it is open. */}
        {messages.length === 0 ? (
          <Pressable
            onPress={Keyboard.dismiss}
            accessible={false}
            style={{ flex: 1 }}
          >
            <ScrollView
              contentContainerStyle={{
                flexGrow: 1,
                justifyContent: 'center',
                paddingHorizontal: 28,
                gap: 12,
              }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
            >
              <View className="items-center gap-3">
                <Ionicons name="sparkles" size={42} color="#00B8D9" />
                <AppText variant="subtitle" className="text-center">
                  {t('mood.emptyTitle')}
                </AppText>
                <AppText variant="body" className="text-center">
                  {t('mood.emptyBody')}
                </AppText>
              </View>

              <AppText variant="caption" className="text-center mt-2">
                {t('mood.examples')}
              </AppText>
              <View className="gap-2">
                {(['mood.example1', 'mood.example2', 'mood.example3'] as const).map((key) => (
                  <PressableScale
                    key={key}
                    onPress={() => submit(t(key))}
                    haptic="selection"
                    activeScale={0.97}
                    accessibilityRole="button"
                    style={{
                      backgroundColor: '#121826',
                      borderRadius: 16,
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                    }}
                  >
                    <AppText variant="body" className="text-txt">
                      {t(key)}
                    </AppText>
                  </PressableScale>
                ))}
              </View>
            </ScrollView>
          </Pressable>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(message) => message.id}
            renderItem={({ item }) => <MoodBubble message={item} />}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            ListFooterComponent={
              isThinking ? (
                <View className="items-start gap-3 mb-3">
                  <GlassView className="rounded-3xl rounded-es-md px-4 py-3">
                    <AppText variant="body" className="text-txt-secondary">
                      {t('mood.thinking')}
                    </AppText>
                  </GlassView>
                  <PosterRowSkeleton count={3} />
                </View>
              ) : null
            }
          />
        )}

        {/* Composer */}
        <View className="px-5" style={{ paddingBottom: TAB_BAR_HEIGHT + 8, paddingTop: 8 }}>
          <GlassView className="rounded-full flex-row items-center ps-5 pe-2 py-2">
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={() => submit()}
              editable={!rateLimited || isPremium}
              placeholder={t('mood.placeholder')}
              placeholderTextColor="#64748B"
              returnKeyType="send"
              blurOnSubmit={false}
              multiline={false}
              className="flex-1 text-txt font-sans text-[15px]"
              style={[
                {
                  includeFontPadding: false,
                  textAlignVertical: 'center',
                  textAlign: I18nManager.isRTL ? 'right' : 'left',
                  paddingVertical: 8,
                },
                // Web-only: suppress the browser focus ring, which RN's
                // TextStyle type has no field for.
                WEB_INPUT_RESET,
              ]}
            />
            <PressableScale
              onPress={() => submit()}
              disabled={!canSubmit}
              haptic="medium"
              activeScale={0.88}
              accessibilityRole="button"
              accessibilityLabel={t('mood.title')}
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: canSubmit ? '#00B8D9' : 'rgba(255,255,255,0.08)',
              }}
            >
              <Ionicons
                name="arrow-up"
                size={20}
                color={canSubmit ? '#000000' : '#64748B'}
              />
            </PressableScale>
          </GlassView>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
