// CI-only overlay (.cjs for the lint config), copied to apps/ios/app.config.js by the ios-e2e job
// AFTER the native fingerprint is computed (an explicit runtimeVersion
// would change it). With runtimeVersion.policy "fingerprint", Expo CLI
// re-runs `expo-updates runtimeversion:resolve` — a full fingerprint of
// the project — for every manifest request; on a small runner that takes
// longer than the dev launcher's 10 s request timeout, so the dev client
// never loaded ("The request timed out"). Pinning the version to the hash
// the job already computed makes the manifest instant and still matches
// the EAS dev client built for that same fingerprint.
module.exports = ({ config }) => ({
  ...config,
  runtimeVersion: process.env.EXPO_RUNTIME_VERSION_PIN || config.runtimeVersion,
});
