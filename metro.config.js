const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// SDK 54 resolves package.json `exports` by default, which can select ESM
// entry points containing `import.meta` (zustand v5, node-vibrant, …).
// Metro serves classic scripts on web, so `import.meta` throws at runtime:
// "Cannot use 'import.meta' outside a module". Preferring the `require`
// (CJS) condition keeps every dependency on Metro-compatible builds.
config.resolver.unstable_conditionNames = ['browser', 'require', 'react-native'];

module.exports = withNativeWind(config, { input: './global.css' });
