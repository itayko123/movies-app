module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    // IMPORTANT (SDK 54): babel-preset-expo auto-injects the worklets
    // transform — `react-native-worklets/plugin` for Reanimated 4 (or the
    // legacy `react-native-reanimated/plugin` for Reanimated 3). Do NOT list
    // either plugin manually here: a manual entry that doesn't match the
    // installed Reanimated major is exactly what produces
    // "Cannot find module 'react-native-worklets/plugin'" and
    // double-transform crashes.
  };
};
