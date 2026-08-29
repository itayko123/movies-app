import { useState } from 'react';
import { ActivityIndicator, Alert, I18nManager, Platform, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import * as Updates from 'expo-updates';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { SectionHeader } from '@/components/SectionHeader';
import { PressableScale } from '@/components/PressableScale';
import { TmdbAttribution } from '@/components/TmdbAttribution';
import { supabase } from '@/lib/supabase';
import { deleteAccount } from '@/lib/cloudSync';
import { purchasesAvailable, restorePurchases } from '@/lib/purchases';
import { safeAsync, safeFireAndForget } from '@/lib/safeNative';
import { hapticSuccess, hapticWarning } from '@/lib/haptics';
import { useT } from '@/i18n';
import { useGenreLabel } from '@/i18n/genres';
import { useAppStore, resetAppData, type Locale } from '@/state/store';
import { C, R, SECTION_ICON, SPACE } from '@/theme/tokens';

/**
 * Settings, split out of the profile in Phase 5 Step 4.
 *
 * ── Why this is its own route ──────────────────────────────────────────────
 * The profile used to be thirteen stacked sections: identity, stats, streak,
 * level, quests, taste, THEN language, settings, delete-account and legal. The
 * reference (`20.47.28.jpeg`) puts configuration behind a gear in the header
 * instead, and it is right to — content and configuration are different jobs.
 * Someone opening their profile is looking for a title they saved; someone
 * opening settings has come to change something. Interleaving the two made the
 * profile long enough that its own content sat below four screens of scroll.
 *
 * Nothing here is new behaviour. Every handler moved across verbatim — the
 * server-first deletion order, the two-step destructive confirmation, the
 * web-Alert fallbacks and the Expo Go reload guards are all as they were.
 */

/** Tappable settings row. Moved with the sections it serves. */
function SettingsRow({
  icon,
  label,
  hint,
  tint = C.textSecondary,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint?: string;
  tint?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      haptic="selection"
      activeScale={0.97}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACE.md,
        borderRadius: R.chip,
        backgroundColor: C.surface,
        paddingHorizontal: SPACE.lg,
        paddingVertical: 14,
      }}
    >
      <Ionicons name={icon} size={18} color={tint} />
      <View className="flex-1">
        <AppText variant="bodyStrong" style={{ color: tint }}>
          {label}
        </AppText>
        {hint && (
          <AppText variant="caption" className="mt-0.5">
            {hint}
          </AppText>
        )}
      </View>
      {/*
        Mirrored by hand — Ionicons does not flip direction-carrying glyphs, so
        under RTL an unmirrored chevron-forward points away from the side the
        row navigates toward.
      */}
      <Ionicons
        name="chevron-forward"
        size={16}
        color={C.textTertiary}
        style={I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined}
      />
    </PressableScale>
  );
}

export default function SettingsScreen() {
  const t = useT();
  const genreLabel = useGenreLabel();
  const router = useRouter();
  const queryClient = useQueryClient();

  const profile = useAppStore((s) => s.profile);
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);
  const preferences = useAppStore((s) => s.preferences);
  const clearPreferences = useAppStore((s) => s.clearPreferences);

  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /**
   * Reopens onboarding.
   *
   * `clearPreferences` FIRST, then `replace`. The gate bounces /onboarding back
   * to / while preferences exist, so the old `push('/onboarding')` navigated
   * and was reversed within the same tick — the button appeared to do nothing.
   *
   * `replace` rather than `push` so a back-swipe out of onboarding cannot
   * strand the user on the deck with no preferences set.
   */
  const redoOnboarding = () => {
    clearPreferences();
    router.replace('/onboarding');
  };

  const switchLocale = async (next: Locale) => {
    if (next === locale) return;

    // Persist the language + flip I18nManager; RTL⇄LTR needs a reload to
    // re-lay-out every native view, so surface that before restarting.
    const needsReload = setLocale(next);
    if (profile) {
      await supabase.from('profiles').update({ locale: next }).eq('id', profile.id);
    }
    if (needsReload) {
      Alert.alert(t('profile.language'), t('profile.rtlNote'), [
        { text: t('common.cancel'), style: 'cancel', onPress: () => setLocale(locale) },
        {
          text: 'OK',
          // Guarded: reloadAsync throws in Expo Go. The language is already
          // applied to I18nManager, so a manual restart completes the flip.
          onPress: () => safeFireAndForget('Updates.reloadAsync', () => Updates.reloadAsync()),
        },
      ]);
    }
  };

  const restore = async () => {
    try {
      const premium = await restorePurchases();
      if (premium) hapticSuccess();
    } catch {
      Alert.alert(t('common.error'));
    }
  };

  /**
   * Wipes in-memory state AND persisted storage, then reloads so the app
   * boots exactly like a fresh install — the routing gate sends you back
   * through onboarding.
   */
  const performReset = async () => {
    setResetting(true);
    hapticWarning();
    await resetAppData();
    queryClient.clear();

    // Updates.reloadAsync throws in Expo Go and on web (it needs expo-updates
    // to be actually enabled), and it throws synchronously — safeAsync catches
    // both that and a rejection. Falling back to routing is enough: the store
    // is already cleared, so the gate sends us through onboarding.
    const reloaded =
      Platform.OS !== 'web' &&
      (await safeAsync('Updates.reloadAsync', () => Updates.reloadAsync())) !== null;

    if (!reloaded) {
      if (Platform.OS === 'web') {
        (globalThis as { location?: { reload: () => void } }).location?.reload();
      } else {
        setResetting(false);
        router.replace('/onboarding');
      }
    }
  };

  /**
   * Irreversible account deletion.
   *
   * Order matters and is not interchangeable:
   *   1. server first — if the RPC fails, NOTHING local is touched and the
   *      user is told plainly that nothing was removed. Wiping locally first
   *      would leave someone staring at an empty app while their data is
   *      still on our servers, which is the opposite of what they asked for;
   *   2. sign out, so the session cannot be reused against a dead user id;
   *   3. clear local state, so the device keeps no copy;
   *   4. route to /auth.
   */
  const performDelete = async () => {
    setDeleting(true);
    try {
      await deleteAccount();
    } catch {
      setDeleting(false);
      hapticWarning();
      Alert.alert(t('profile.deleteTitle'), t('profile.deleteFailed'));
      return;
    }

    // Best-effort from here on — the account is already gone, so a failure to
    // sign out locally must not strand the user on this screen.
    await safeAsync('supabase.auth.signOut', () => supabase.auth.signOut());
    await resetAppData();
    queryClient.clear();
    setDeleting(false);
    router.replace('/auth');
  };

  /**
   * Two confirmations, not one.
   *
   * This destroys data with no recovery path and no undo. A single dialog is
   * one mis-tap away from an unrecoverable loss, and the second prompt costs
   * nothing to anyone who genuinely means it.
   */
  const confirmDelete = () => {
    if (Platform.OS === 'web') {
      // Alert on react-native-web renders no buttons, so the native
      // confirmation chain cannot run. Use the browser's own dialogs rather
      // than deleting an account with no confirmation at all.
      const ok = (globalThis as { confirm?: (message: string) => boolean }).confirm?.(
        `${t('profile.deleteTitle')}\n\n${t('profile.deleteBody')}`,
      );
      if (ok) void performDelete();
      return;
    }

    Alert.alert(t('profile.deleteTitle'), t('profile.deleteBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('profile.deleteConfirm'),
        style: 'destructive',
        onPress: () =>
          Alert.alert(t('profile.deleteFinalTitle'), t('profile.deleteFinalBody'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('profile.deleteFinalConfirm'),
              style: 'destructive',
              onPress: () => void performDelete(),
            },
          ]),
      },
    ]);
  };

  const confirmReset = () => {
    if (Platform.OS === 'web') {
      // Alert on react-native-web renders no buttons — go straight through.
      void performReset();
      return;
    }
    Alert.alert(t('profile.resetTitle'), t('profile.resetBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('profile.resetConfirm'),
        style: 'destructive',
        onPress: () => void performReset(),
      },
    ]);
  };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1 }}>
      <View
        className="flex-row items-center"
        style={{ paddingHorizontal: SPACE.edge, paddingBottom: SPACE.sm, gap: SPACE.md }}
      >
        <PressableScale
          onPress={() => router.back()}
          haptic="selection"
          activeScale={0.88}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          style={{
            width: SECTION_ICON.size,
            height: SECTION_ICON.size,
            borderRadius: SECTION_ICON.radius,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: C.surface,
          }}
        >
          {/*
            `chevron-back` points at the screen you came from, which is the
            opposite side under RTL — and Ionicons will not flip it for us.
          */}
          <Ionicons
            name="chevron-back"
            size={18}
            color={C.text}
            style={I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined}
          />
        </PressableScale>
        <AppText variant="title" numberOfLines={1} className="flex-1">
          {t('profile.settings')}
        </AppText>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: SPACE.edge,
          paddingTop: SPACE.md,
          paddingBottom: 60,
          gap: 22,
          width: '100%',
          maxWidth: 640,
          alignSelf: 'center',
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Language / RTL */}
        <View className="gap-3">
          <SectionHeader icon="language" title={t('profile.language')} />
          <View className="flex-row gap-3">
            {(
              [
                ['en', t('profile.english')],
                ['he', t('profile.hebrew')],
              ] as Array<[Locale, string]>
            ).map(([value, label]) => {
              const active = locale === value;
              return (
                <PressableScale
                  key={value}
                  onPress={() => void switchLocale(value)}
                  haptic="selection"
                  activeScale={0.95}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={{
                    flex: 1,
                    borderRadius: R.chip,
                    paddingVertical: 14,
                    alignItems: 'center',
                    backgroundColor: active ? C.accentSoft : C.surface,
                  }}
                >
                  {/*
                    `style`, not `text-brand` — the same dead-class trap fixed
                    in SectionHeader. It left the selected language rendering
                    plain white, so the only thing distinguishing it from the
                    other option was the background tint.
                  */}
                  <AppText
                    variant="bodyStrong"
                    style={active ? { color: C.accent } : undefined}
                  >
                    {label}
                  </AppText>
                </PressableScale>
              );
            })}
          </View>
        </View>

        {/*
          Named 'Account & app', not 'Settings'. This screen is now titled
          Settings, so a section inside it with the same name read as a
          duplicate heading. The group really covers both: onboarding and data
          reset are app-level, sign-out and deletion are account-level.
        */}
        <View className="gap-3">
          <SectionHeader icon="settings" title={t('settings.accountApp')} />

          <SettingsRow
            icon="options"
            label={t('profile.redoOnboarding')}
            hint={
              preferences?.genres.length
                ? preferences.genres.slice(0, 3).map(genreLabel).join(' · ')
                : t('profile.noPicks')
            }
            onPress={redoOnboarding}
          />

          {purchasesAvailable() && (
            <SettingsRow
              icon="refresh-circle"
              label={t('profile.restore')}
              onPress={() => void restore()}
            />
          )}

          <SettingsRow
            icon="refresh"
            label={t('profile.resetData')}
            hint={t('profile.resetHint')}
            onPress={confirmReset}
            disabled={resetting}
          />

          <SettingsRow
            icon="log-out"
            label={t('profile.signOut')}
            tint={C.nope}
            onPress={() => void supabase.auth.signOut()}
          />

          {/*
            Deletion sits last and is styled apart from the rows above: a
            tinted red card rather than the neutral surface every other setting
            uses. Nothing else on this screen is unrecoverable, so nothing else
            should look like this.
          */}
          <PressableScale
            onPress={confirmDelete}
            disabled={deleting}
            haptic="medium"
            activeScale={0.97}
            accessibilityRole="button"
            accessibilityLabel={t('profile.deleteAccount')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: SPACE.md,
              marginTop: 6,
              borderRadius: R.chip,
              backgroundColor: C.nopeSoft,
              paddingHorizontal: SPACE.lg,
              paddingVertical: 14,
            }}
          >
            <Ionicons name="trash" size={18} color={C.nope} />
            <View className="flex-1">
              <AppText variant="bodyStrong" style={{ color: C.nope }}>
                {deleting ? t('profile.deleting') : t('profile.deleteAccount')}
              </AppText>
              <AppText variant="caption" className="mt-0.5">
                {t('profile.deleteHint')}
              </AppText>
            </View>
            {deleting ? (
              <ActivityIndicator color={C.nope} />
            ) : (
              <Ionicons
                name="chevron-forward"
                size={16}
                color={C.nope}
                style={I18nManager.isRTL ? { transform: [{ scaleX: -1 }] } : undefined}
              />
            )}
          </PressableScale>
        </View>

        {/* Legal & about. Last on purpose — reference material, not something
            anyone came here to do. */}
        <View className="gap-3">
          <SectionHeader icon="document-text" title={t('profile.legal')} />

          <SettingsRow
            icon="shield-checkmark"
            label={t('profile.privacy')}
            hint={t('profile.privacyHint')}
            onPress={() => router.push({ pathname: '/legal/[doc]', params: { doc: 'privacy' } })}
          />

          <SettingsRow
            icon="document-text"
            label={t('profile.terms')}
            hint={t('profile.termsHint')}
            onPress={() => router.push({ pathname: '/legal/[doc]', params: { doc: 'terms' } })}
          />

          {/* Required by TMDB's API terms — see TmdbAttribution. */}
          <TmdbAttribution />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
