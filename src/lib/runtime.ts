import Constants, { ExecutionEnvironment } from 'expo-constants';

/**
 * True when running inside the Expo Go sandbox app.
 *
 * Expo Go ships a fixed set of native modules. Anything outside that set —
 * MMKV, image-colors, AdMob, Firebase, RevenueCat, Google Sign-In — is simply
 * absent, and merely *importing* such a package throws
 * "Cannot find native module '…'" while the module graph is still loading,
 * which crashes the app before any of our code runs.
 *
 * Every integration that touches one of those packages must therefore
 * `require()` it lazily behind this flag and provide a fallback.
 */
export const IS_EXPO_GO =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** A dev/prod build that contains our own native code (`expo run:*`, EAS). */
export const HAS_CUSTOM_NATIVE_CODE = !IS_EXPO_GO;
