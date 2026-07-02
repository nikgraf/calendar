// @ts-check
const osxNotarize =
  process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
        tool: 'notarytool',
      }
    : undefined;

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],
  packagerConfig: {
    appBundleId: 'com.nikgraf.calendar',
    executableName: 'calendar',
    ignore: [
      /^\/electron(?:$|\/)/,
      /^\/renderer(?:$|\/)/,
      /^\/index\.html$/,
      /^\/forge\.config\.cjs$/,
      /^\/tsconfig\.json$/,
      /^\/tsdown\.config\.ts$/,
      /^\/vite\.config\./,
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
