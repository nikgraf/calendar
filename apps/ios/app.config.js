/**
 * Two variants of the app that install side by side (docs/distribution.md):
 *
 * - production (`com.solunivo.app`): TestFlight and the App Store. This is
 *   `app.json` as written, and the default — a release job that forgets
 *   `APP_VARIANT` can never ship the dev identity.
 * - development (`com.solunivo.app.dev`): the dev client, for a device and
 *   for the simulator CI drives. Selected with `APP_VARIANT=development`,
 *   which the two development profiles in `eas.json`, the `start`/`ios`/
 *   `prebuild` scripts and the iOS e2e jobs set.
 *
 * Everything iOS keys on the bundle id (database, Keychain, permissions,
 * notifications) separates by itself. What must differ on top is what two
 * installed apps would otherwise both claim: the URL schemes, and with them
 * the Google OAuth client, whose redirect is its reversed client id.
 *
 * The variants have different native fingerprints, so whatever computes one
 * (`fingerprint:generate`, `eas update`) has to run under the same
 * `APP_VARIANT` as the build it is meant to match.
 *
 * Plain CommonJS on purpose, not TypeScript: Expo CLI evaluates this file
 * for every manifest request, once more in a fresh process each time, and
 * a .ts config has to be transpiled there first. On a CI runner that put
 * the dev launcher's first request after a launch past its 10 s budget.
 */

/** The iOS OAuth client registered for `com.solunivo.app.dev`. */
const DEV_GOOGLE_IOS_CLIENT_ID =
  '930599242270-9nm0noj40jiamnc6ettbj36gdei0adis.apps.googleusercontent.com';

/** @returns {'development' | 'production'} */
const variant = () => {
  const value = process.env.APP_VARIANT ?? 'production';
  if (value !== 'development' && value !== 'production') {
    throw new Error(`APP_VARIANT must be "development" or "production", got "${value}"`);
  }
  return value;
};

/**
 * Google's redirect scheme for an iOS client (see `redirectUriFor` in src/googleAuth.ts).
 * @param {string} clientId
 */
const reversedClientId = (clientId) =>
  `com.googleusercontent.apps.${clientId.replace('.apps.googleusercontent.com', '')}`;

/**
 * @param {import('expo/config').ConfigContext} context
 * @returns {Partial<import('expo/config').ExpoConfig>}
 */
module.exports = ({ config }) => {
  const base = {
    ...config,
    // With runtimeVersion.policy "fingerprint", Expo CLI re-runs
    // `expo-updates runtimeversion:resolve` — a full fingerprint of the
    // project — for every manifest request; on a small CI runner that
    // takes longer than the dev launcher's 10 s request timeout, so the
    // dev client never loaded ("The request timed out"). The e2e jobs pin
    // the version to the hash they already computed: the manifest is
    // instant and still matches the EAS dev client built for that
    // fingerprint. Set for Metro only, never while the fingerprint itself
    // is computed — an explicit runtimeVersion would change it.
    runtimeVersion: process.env.EXPO_RUNTIME_VERSION_PIN || config.runtimeVersion,
  };
  if (variant() === 'production') {
    return {
      ...base,
      // expo-dev-client is applied automatically and registers
      // `exp+solunivo://` in every build. The production app has no dev
      // launcher to answer it, and next to the dev variant it would
      // compete for the links Expo CLI opens. Listed first: the local
      // notifications plugin has to stay last.
      plugins: [['expo-dev-client', { addGeneratedScheme: false }], ...(config.plugins ?? [])],
    };
  }
  return {
    ...base,
    extra: { ...config.extra, googleIosClientId: DEV_GOOGLE_IOS_CLIENT_ID },
    ios: {
      ...config.ios,
      bundleIdentifier: 'com.solunivo.app.dev',
      icon: './assets/icon-dev.png',
    },
    name: 'Solunivo Dev',
    scheme: ['solunivo-dev', reversedClientId(DEV_GOOGLE_IOS_CLIENT_ID)],
  };
};
