import { useCallback, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import {
  ThemeProvider as NavigationThemeProvider,
  DarkTheme,
  type Theme,
} from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { useFonts, SecularOne_400Regular } from '@expo-google-fonts/secular-one';
import {
  Rubik_400Regular,
  Rubik_500Medium,
  Rubik_600SemiBold,
  Rubik_700Bold,
  Rubik_800ExtraBold,
} from '@expo-google-fonts/rubik';

import '../global.css';

import { applyLayoutDirection } from '@/lib/direction';
import { initStorage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import { initAds } from '@/lib/ads';
import { configurePurchases, purchasesAvailable } from '@/lib/purchases';
import { safeAsync, safeFireAndForget } from '@/lib/safeNative';
import { useAppStore } from '@/state/store';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { useCloudSync } from '@/hooks/useCloudSync';
import { useAuthDeepLink } from '@/hooks/useAuthDeepLink';
import { ProfileSchema } from '@/types/db';
import { MOCK_AUTH_ENABLED, mockAuthState } from '@/lib/devMock';

safeFireAndForget('SplashScreen.preventAutoHideAsync', () =>
  SplashScreen.preventAutoHideAsync(),
);

/** Root surface colour. Keep in sync with `app` in tailwind.config.js. */
export const APP_BG = '#000000';

const NAV_DARK_THEME: Theme = {
  ...DarkTheme,
  dark: true,
  colors: {
    ...DarkTheme.colors,
    background: APP_BG,
    card: '#121826',
    text: '#FAFAFA',
    border: 'rgba(148,163,184,0.14)',
    primary: '#00B8D9',
    notification: '#00B8D9',
  },
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

// React Query's default focus manager targets the browser; wire it to RN.
focusManager.setEventListener((handleFocus) => {
  const subscription = require('react-native').AppState.addEventListener(
    'change',
    (status: string) => handleFocus(status === 'active'),
  );
  return () => subscription.remove();
});

function useBootstrap(): boolean {
  const [storageReady, setStorageReady] = useState(false);
  const setSession = useAppStore((s) => s.setSession);
  const setProfile = useAppStore((s) => s.setProfile);
  const setSessionLoaded = useAppStore((s) => s.setSessionLoaded);
  const setPremium = useAppStore((s) => s.setPremium);

  const [fontsLoaded, fontError] = useFonts({
    SecularOne_400Regular,
    Rubik_400Regular,
    Rubik_500Medium,
    Rubik_600SemiBold,
    Rubik_700Bold,
    Rubik_800ExtraBold,
  });

  // 1. Encrypted MMKV must exist before the store rehydrates, because the
  //    cached premium entitlement lives inside it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await initStorage();
      await useAppStore.persist.rehydrate();
      if (cancelled) return;

      // Apply the persisted language (Hebrew by default) to the layout
      // direction. Must run before the first paint, or a Hebrew user sees one
      // LTR frame of onboarding.
      applyLayoutDirection(useAppStore.getState().locale);

      // expo-system-ui validates arguments synchronously and throws a
      // CodedError where the call isn't supported (notably iOS/Expo Go), so a
      // trailing `.catch()` would never run — the throw escapes the enclosing
      // async function as an unhandled rejection and red-screens the app.
      // safeAsync wraps the invocation itself. Android is the only platform
      // where this actually does anything.
      if (Platform.OS === 'android') {
        await safeAsync('SystemUI.setBackgroundColorAsync', () =>
          SystemUI.setBackgroundColorAsync(APP_BG),
        );
      }
      setStorageReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Session + profile hydration, once storage is live.
  useEffect(() => {
    if (!storageReady) return;

    // ─────────────────────────────────────────────────────────────────────
    // TODO: MOCK AUTH - REMOVE BEFORE PRODUCTION
    // Injects a fake session/profile so the app boots straight into (tabs).
    // See src/lib/devMock.ts for how to disable or delete this.
    if (MOCK_AUTH_ENABLED) {
      const { session, profile } = mockAuthState();
      setSession(session);
      setProfile(profile);
      setPremium(profile.is_premium);
      setSessionLoaded();
      void initAds();
      return;
    }
    // END MOCK AUTH
    // ─────────────────────────────────────────────────────────────────────

    const loadProfile = async (userId: string) => {
      const { data } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url, locale, is_premium, streak_count, longest_streak, last_swipe_date, cinephile_level, xp')
        .eq('id', userId)
        .single();
      const parsed = ProfileSchema.safeParse(data);
      if (parsed.success) {
        setProfile(parsed.data);
        // Server truth refreshes the offline-cached entitlement.
        setPremium(parsed.data.is_premium);
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setSessionLoaded();
      if (session) {
        void loadProfile(session.user.id);
        if (purchasesAvailable()) void configurePurchases(session.user.id);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) {
        void loadProfile(session.user.id);
        if (purchasesAvailable()) void configurePurchases(session.user.id);
      } else {
        useAppStore.getState().reset();
      }
    });

    void initAds();
    return () => subscription.unsubscribe();
  }, [storageReady, setSession, setProfile, setSessionLoaded, setPremium]);

  return storageReady && (fontsLoaded || fontError != null);
}

/**
 * Routing gate: unauthenticated users go to /auth, and signed-in users
 * without saved preferences go to /onboarding before reaching the deck.
 */
function useAuthGate(ready: boolean): void {
  const session = useAppStore((s) => s.session);
  const sessionLoaded = useAppStore((s) => s.sessionLoaded);
  const preferences = useAppStore((s) => s.preferences);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready || !sessionLoaded) return;
    const onAuthScreen = segments[0] === 'auth';
    const onWelcome = segments[0] === 'welcome';
    const onOnboarding = segments[0] === 'onboarding';

    // Dev-only bypass of the auth half of the gate; the onboarding half below
    // still applies. Inert in release builds (see src/lib/devMock.ts).
    const authed = MOCK_AUTH_ENABLED || session != null;

    // Signed-out users land on the animated welcome first; /auth is reached
    // from its CTA, so the sign-in form is never the app's cold-open.
    if (!authed && !onAuthScreen && !onWelcome) {
      router.replace('/welcome');
      return;
    }
    if (authed && (onAuthScreen || onWelcome)) {
      router.replace('/');
      return;
    }
    // Cold start: no saved taste yet → collect it before the deck.
    if (authed && preferences == null && !onOnboarding) {
      router.replace('/onboarding');
    } else if (authed && preferences != null && onOnboarding) {
      router.replace('/');
    }
  }, [ready, sessionLoaded, session, preferences, segments, router]);
}

export default function RootLayout() {
  const ready = useBootstrap();
  useAuthGate(ready);
  // Mirrors local state to Supabase and pulls it back on a new device. A no-op
  // when no backend is configured or nobody is signed in.
  useCloudSync();
  // Completes a sign-in arriving as cineswipe:// or exp:// — magic links and
  // OAuth callbacks on device, where there is no address bar for supabase-js
  // to read. No-op on web.
  useAuthDeepLink();

  const onLayout = useCallback(() => {
    if (ready) safeFireAndForget('SplashScreen.hideAsync', () => SplashScreen.hideAsync());
  }, [ready]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: APP_BG }} onLayout={onLayout}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          {/* React Navigation defaults to its LIGHT theme, which paints a
              full-screen #F2F2F2 scene background under every route. Supplying
              the dark theme is what keeps the app dark on web. */}
          <NavigationThemeProvider value={NAV_DARK_THEME}>
            <ThemeProvider>
              <StatusBar style="light" />
              <View className="flex-1 bg-app">
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: APP_BG },
                  animation: 'fade',
                }}
              >
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="welcome" options={{ animation: 'fade' }} />
                <Stack.Screen name="auth" options={{ animation: 'fade' }} />
                <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
                <Stack.Screen
                  name="media/[id]"
                  options={{ animation: 'default', presentation: 'card' }}
                />
                <Stack.Screen
                  name="duo/invite/[code]"
                  options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                />
                <Stack.Screen
                  name="paywall"
                  options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                />
                <Stack.Screen
                  name="settings"
                  options={{ animation: 'slide_from_right' }}
                />
                <Stack.Screen
                  name="legal/[doc]"
                  options={{ animation: 'slide_from_right' }}
                />
              </Stack>
              </View>
            </ThemeProvider>
          </NavigationThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
