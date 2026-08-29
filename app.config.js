const fs = require('fs');
const path = require('path');

// Firebase (App Check) is wired in only when the service files are present,
// so `expo prebuild` / `expo run:android` work on a fresh clone before
// Firebase is configured. At runtime, src/lib/appCheck.native.ts degrades to
// a null token when the Firebase native module is absent.
const hasAndroidGoogleServices = fs.existsSync(path.join(__dirname, 'google-services.json'));
const hasIosGoogleServices = fs.existsSync(path.join(__dirname, 'GoogleService-Info.plist'));
const firebaseEnabled = hasAndroidGoogleServices || hasIosGoogleServices;

/**
 * iOS URL scheme for native Google Sign-In: the iOS client id with its
 * dot-segments reversed, e.g.
 *   1234-abc.apps.googleusercontent.com
 *   → com.googleusercontent.apps.1234-abc
 *
 * Google's SDK returns to the app on this scheme, and iOS silently drops the
 * callback if it is not registered — the sign-in sheet opens and then nothing
 * happens. Derived rather than hand-copied because the two must always agree.
 *
 * Only the WEB client id is required for Supabase to validate the id token;
 * this needs the separate iOS client id, so it stays optional and the whole
 * plugin entry degrades to its bare form until EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
 * is set.
 */
const iosGoogleClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';
const iosGoogleUrlScheme = iosGoogleClientId.endsWith('.apps.googleusercontent.com')
  ? `com.googleusercontent.apps.${iosGoogleClientId.replace('.apps.googleusercontent.com', '')}`
  : null;

module.exports = {
  expo: {
    // Display name. `slug` and `scheme` intentionally keep the original
    // identifier: they are registered with EAS / OAuth providers and appear in
    // magic-link redirects, so renaming them would break installed builds.
    name: 'תבחר לי סרט',
    slug: 'cineswipe',
    version: '1.0.0',
    orientation: 'portrait',
    scheme: 'cineswipe',
    userInterfaceStyle: 'dark',
    backgroundColor: '#000000',
    newArchEnabled: true,
    supportsRTL: true,
    // Ties an OTA update to a binary that can actually run it. `appVersion`
    // means a native change (new module, new permission) requires a version
    // bump before an update can reach it — which is what stops an update
    // shipping JS that calls into native code the installed app lacks.
    runtimeVersion: { policy: 'appVersion' },
    web: {
      bundler: 'metro',
      output: 'single',
    },
    ios: {
      bundleIdentifier: 'com.cineswipe.app',
      supportsTablet: false,
      usesAppleSignIn: true,
      ...(hasIosGoogleServices ? { googleServicesFile: './GoogleService-Info.plist' } : {}),
      infoPlist: {
        CFBundleAllowMixedLocalizations: true,
      },
    },
    android: {
      package: 'com.cineswipe.app',
      ...(hasAndroidGoogleServices ? { googleServicesFile: './google-services.json' } : {}),
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: [{ scheme: 'https', host: 'cineswipe.app', pathPrefix: '/duo' }],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-apple-authentication',
      'expo-localization',
      ['expo-font', { fonts: [] }],
      ['expo-splash-screen', { backgroundColor: '#000000' }],
      ...(firebaseEnabled
        ? ['@react-native-firebase/app', '@react-native-firebase/app-check']
        : []),
      iosGoogleUrlScheme
        ? ['@react-native-google-signin/google-signin', { iosUrlScheme: iosGoogleUrlScheme }]
        : '@react-native-google-signin/google-signin',
      [
        'react-native-google-mobile-ads',
        {
          // Google's public sample App IDs — replace with your own for release.
          androidAppId: 'ca-app-pub-3940256099942544~3347511713',
          iosAppId: 'ca-app-pub-3940256099942544~1458002511',
        },
      ],
      ['expo-build-properties', { ios: { useFrameworks: 'static' } }],
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: { origin: false },
    },
  },
};
