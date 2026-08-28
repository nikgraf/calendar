// @ts-check
const { cp, mkdir } = require('node:fs/promises');
const { join } = require('node:path');

const osxNotarize =
  process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
        tool: 'notarytool',
      }
    : undefined;

// The main bundle inlines everything except these packages; they are copied
// into the packaged app. effect stays external because its self-referencing
// imports defeat the bundler. (better-sqlite3 left this list when
// @effect/sql-sqlite-node moved to node:sqlite in effect 4.0.0-rc.)
const RUNTIME_PACKAGES = ['effect'];

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      const rootModules = join(__dirname, '../../node_modules');
      for (const name of RUNTIME_PACKAGES) {
        await mkdir(join(buildPath, 'node_modules', name), { recursive: true });
        await cp(join(rootModules, name), join(buildPath, 'node_modules', name), {
          dereference: true,
          // Nested .bin dirs hold symlinks into the hoisted store — some
          // dangling (effect@rc ships one for uuid), and dereference:true
          // dies on those. The packaged app never execs .bin anyway.
          filter: (source) => !source.includes(`${'node_modules'}/.bin`),
          recursive: true,
        });
      }
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],
  packagerConfig: {
    appBundleId: 'com.solunivo.desktop',
    asar: false,
    // The Swift model helper (Foundation Models + SpeechAnalyzer over
    // stdio) rides in Resources; osx-sign signs Mach-O binaries it finds
    // in the bundle, and CI's codesign --verify --deep covers it via the
    // resource seal.
    extraResource: ['helper/.build/release/solunivo-model-helper'],
    // CFBundleVersion; CI sets the short commit SHA so testers can identify
    // builds. Undefined locally — packager skips it.
    buildVersion: process.env.BUILD_VERSION,
    executableName: 'solunivo',
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Solunivo uses the microphone to turn what you say into an event. ' +
        'Audio is transcribed on your device and never uploaded.',
    },
    ignore: [
      /^\/electron(?:$|\/)/,
      /^\/renderer(?:$|\/)/,
      /^\/index\.html$/,
      /^\/forge\.config\.cjs$/,
      /^\/tsconfig\.json$/,
      /^\/tsdown\.config\.ts$/,
      /^\/vite\.config\./,
      /^\/google-oauth\.local\.json$/,
      /^\/node_modules(?:$|\/)/,
      // Never ship: Swift sources + 68MB of SPM build objects (the built
      // binary already rides in Resources via extraResource), the e2e
      // harness, and e2e-artifacts — local test runs leave calendar
      // SCREENSHOTS there, and a make after that would hand them out.
      /^\/helper(?:$|\/)/,
      /^\/e2e(?:$|\/)/,
      /^\/e2e-artifacts(?:$|\/)/,
      /^\/\.gitignore$/,
    ],
    name: 'Solunivo',
    ...(osxNotarize ? { osxNotarize } : {}),
    ...(process.env.APPLE_SIGNING_IDENTITY
      ? {
          osxSign: {
            // Packager defaults this to true, demoting per-file codesign
            // failures to warnings that resurface as confusing notarization
            // errors — fail at the signing step instead.
            continueOnError: false,
            hardenedRuntime: true,
            identity: process.env.APPLE_SIGNING_IDENTITY,
          },
        }
      : {}),
  },
  publishers: [
    {
      config: {
        draft: true,
        repository: { name: 'calendar', owner: 'nikgraf' },
      },
      name: '@electron-forge/publisher-github',
    },
  ],
  rebuildConfig: {},
};
