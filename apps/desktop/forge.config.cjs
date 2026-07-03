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
// into the packaged app (better-sqlite3 is native and carries its runtime
// deps; effect is left external because its self-referencing imports defeat
// the bundler).
const RUNTIME_PACKAGES = ['effect', 'better-sqlite3', 'bindings', 'file-uri-to-path'];

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      const rootModules = join(__dirname, '../../node_modules');
      for (const name of RUNTIME_PACKAGES) {
        await mkdir(join(buildPath, 'node_modules', name), { recursive: true });
        await cp(join(rootModules, name), join(buildPath, 'node_modules', name), {
          dereference: true,
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
    appBundleId: 'com.nikgraf.calendar',
    asar: false,
    executableName: 'calendar',
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
    ],
    name: 'Calendar',
    ...(osxNotarize ? { osxNotarize } : {}),
    ...(process.env.APPLE_SIGNING_IDENTITY
      ? {
          osxSign: {
            hardenedRuntime: true,
            identity: process.env.APPLE_SIGNING_IDENTITY,
          },
        }
      : {}),
  },
  rebuildConfig: {},
};
