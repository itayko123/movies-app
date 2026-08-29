import { IS_EXPO_GO } from '@/lib/runtime';

/**
 * Firebase App Check (Play Integrity / DeviceCheck) — native builds only.
 *
 * `@react-native-firebase/app-check` is lazy-required so that merely importing
 * this module is safe in Expo Go (which lacks the Firebase native code).
 * In Expo Go we return null; pair local backend runs with
 * APP_CHECK_ENFORCED=false. Web resolves appCheck.web.ts instead.
 */


let initPromise: Promise<void> | null = null;

export async function getAppCheckToken(): Promise<string | null> {
  if (IS_EXPO_GO) return null;

  try {
    const { firebase } = require('@react-native-firebase/app-check');

    if (!initPromise) {
      initPromise = (async () => {
        const appCheck = firebase.appCheck();
        const provider = appCheck.newReactNativeFirebaseAppCheckProvider();
        provider.configure({
          android: { provider: __DEV__ ? 'debug' : 'playIntegrity' },
          apple: { provider: __DEV__ ? 'debug' : 'deviceCheck' },
        });
        await appCheck.initializeAppCheck({
          provider,
          isTokenAutoRefreshEnabled: true,
        });
      })();
    }
    await initPromise;

    const { token } = await firebase.appCheck().getToken(false);
    return token || null;
  } catch (err) {
    if (__DEV__) {
      console.warn('App Check unavailable:', err);
    }
    initPromise = null;
    return null;
  }
}
