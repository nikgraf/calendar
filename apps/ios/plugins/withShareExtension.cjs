// The iOS share sheet: "Share → Solunivo" hands a screenshot or a text to
// the app, which extracts the events it describes (capture). expo-sharing's
// own config plugin adds the share-extension target and the app group; this
// wrapper exists because, applied as is, it would break here in three ways:
//
// - It writes `config.scheme` verbatim into the extension's Info.plist as
//   `MainTargetUrlScheme`, and the extension `fatalError`s unless that is a
//   string. Both variants declare an array of schemes (the app's own plus
//   Google's reversed client id), so the upstream plugin is handed the
//   first one — `solunivo` / `solunivo-dev` — and the array is restored.
// - The extension's display name is `$(PRODUCT_NAME)`, i.e. the target name
//   "expo-sharing-extension". The share sheet should say "Solunivo" (or
//   "Solunivo Dev"), so the generated plist is patched to the app's name.
//   Mods run last-registered first, so this one is registered before the
//   upstream plugin and therefore runs after it wrote the file.
// - Everything two installed apps would both claim must differ per variant:
//   the extension's bundle id and the app group derive from the final
//   bundle id (plugins see the config after app.config.js chose the
//   variant) and are pinned explicitly so an upstream default can never
//   silently register a new App ID.
//
// EAS learns about the extension (target, bundle id, app-group entitlement)
// from `extra.eas.build.experimental.ios.appExtensions`, which the upstream
// plugin writes itself. Listed in app.json before withLocalNotificationsOnly,
// which has to stay last.
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');
const plist = require('@expo/plist').default;
const withExpoSharing = require('expo-sharing/app.plugin.js').default;

/** The upstream plugin's fixed target (and generated directory) name. */
const TARGET_NAME = 'expo-sharing-extension';

/** @param {import('expo/config').ExpoConfig} config */
const withExtensionDisplayName = (config) =>
  withDangerousMod(config, [
    'ios',
    (config) => {
      const infoPlistPath = join(config.modRequest.platformProjectRoot, TARGET_NAME, 'Info.plist');
      const info = plist.parse(readFileSync(infoPlistPath, 'utf8'));
      if (typeof info.MainTargetUrlScheme !== 'string') {
        throw new Error(
          `withShareExtension: MainTargetUrlScheme is ${JSON.stringify(info.MainTargetUrlScheme)}, not a string — the extension would crash on launch.`,
        );
      }
      info.CFBundleDisplayName = config.name;
      writeFileSync(infoPlistPath, plist.build(info));
      return config;
    },
  ]);

/** @param {import('expo/config').ExpoConfig} config */
module.exports = (config) => {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (!bundleIdentifier) {
    throw new Error('withShareExtension: ios.bundleIdentifier is required');
  }
  const schemes = Array.isArray(config.scheme) ? config.scheme : [config.scheme];
  const [scheme] = schemes;
  if (typeof scheme !== 'string') {
    throw new Error('withShareExtension: the app needs a URL scheme for the extension to open it');
  }
  const withSharing = withExpoSharing(
    { ...withExtensionDisplayName(config), scheme },
    {
      ios: {
        activationRule: { supportsImageWithMaxCount: 1, supportsText: true },
        appGroupId: `group.${bundleIdentifier}`,
        enabled: true,
        extensionBundleIdentifier: `${bundleIdentifier}.share`,
      },
    },
  );
  return { ...withSharing, scheme: config.scheme };
};
