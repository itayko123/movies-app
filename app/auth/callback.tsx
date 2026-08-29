import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

import { AppText } from '@/components/AppText';
import { PressableScale } from '@/components/PressableScale';
import { completeAuth } from '@/lib/authCallback';
import { hapticSuccess, hapticWarning } from '@/lib/haptics';
import { useT } from '@/i18n';
import { C } from '@/theme/tokens';

/**
 * Landing route for `…/--/auth/callback?code=…`.
 *
 * ── Why a screen is needed at all ──────────────────────────────────────────
 * The root `useAuthDeepLink` listener already redeems the code, but Expo Router
 * ALSO navigates to whatever path the deep link names — and with no file here
 * that resolved to "Unmatched Route". The session was being created correctly
 * behind a full-screen 404, which reads as a total failure.
 *
 * Both paths now call `completeAuth`, which redeems a given credential exactly
 * once (see authCallback.ts) — an auth code is single-use, so the loser of that
 * race must not spend it again.
 *
 * ── Routing on success ─────────────────────────────────────────────────────
 * `router.replace('/')` rather than `push`: the callback URL must not survive
 * in history, or a back-swipe returns to a screen holding a spent code. The
 * auth gate in _layout then sends the user to onboarding or the deck as
 * appropriate — this screen deliberately does not decide that.
 */
export default function AuthCallbackScreen() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{
    code?: string;
    token_hash?: string;
    token?: string;
    type?: string;
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  }>();

  const [error, setError] = useState<string | null>(null);
  /** Params identity is unstable across renders; run the exchange once. */
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      const result = await completeAuth(params);

      if (result.ok) {
        hapticSuccess();
        router.replace('/');
        return;
      }

      // Nothing redeemable in the URL at all — someone opened the route
      // directly. Not an error worth showing; just go back to sign-in.
      if (!result.actionable) {
        router.replace('/auth');
        return;
      }

      hapticWarning();
      setError(result.error ?? t('auth.error'));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <View className="flex-1 bg-app items-center justify-center gap-4 px-10">
        <Ionicons name="alert-circle-outline" size={40} color="#E8503F" />
        <AppText variant="subtitle" className="text-center">
          {t('auth.callbackFailed')}
        </AppText>
        <AppText variant="caption" className="text-center text-txt-secondary">
          {error}
        </AppText>
        <PressableScale
          onPress={() => router.replace('/auth')}
          haptic="medium"
          accessibilityRole="button"
          style={{
            marginTop: 8,
            backgroundColor: '#00B8D9',
            borderRadius: 999,
            paddingHorizontal: 32,
            paddingVertical: 12,
          }}
        >
          <AppText variant="bodyStrong" style={{ color: C.onAccent }}>
            {t('auth.backToSignIn')}
          </AppText>
        </PressableScale>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-app items-center justify-center gap-4">
      <ActivityIndicator color="#00B8D9" />
      <AppText variant="body" className="text-txt-secondary">
        {t('auth.completing')}
      </AppText>
    </View>
  );
}
