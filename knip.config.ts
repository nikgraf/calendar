import type { KnipConfig } from 'knip';

/**
 * `pnpm knip` (part of the gate): files nothing reaches, exports nothing
 * reads, dependencies nothing imports and imports nothing declares.
 *
 * An export its own file uses counts as used (`ignoreExportsUsedInFile`), so
 * every export reported here is dead code. The packages' `"./*"` exports
 * make each of their files an entry, which would hide every unused export
 * in them; `includeEntryExports` reports those too, and an import from
 * another workspace still counts as a use.
 */
export default {
  ignoreExportsUsedInFile: true,
  workspaces: {
    '.': {
      entry: ['scripts/**/*.{ts,mjs}', 'brand/preview/*.js'],
      // macOS's own tool, run by brand:build.
      ignoreBinaries: ['iconutil'],
      ignoreDependencies: [
        // Added with the EAS pipeline (#22); nothing here imports it, and
        // EAS's cloud install is not part of the gate.
        'tslib',
        // vite-plus's core under vite's name, for the plugins that peer on it.
        'vite',
      ],
    },
    'apps/desktop': {
      entry: [
        // The three `vp pack` entries in vite.config.ts.
        'electron/main.ts',
        'electron/cli.ts',
        'electron/preload.ts',
        // Under E2E=1 only, which knip does not set.
        'e2e/**/*.e2e.ts',
        'public/*.worklet.js',
      ],
      ignoreBinaries: ['swift'],
      // The JSDoc type of forge.config.cjs, from @electron-forge/cli.
      ignoreDependencies: ['@electron-forge/shared-types'],
    },
    'apps/ios': {
      entry: ['e2e/live/scripts/*.js', 'fingerprint.config.cjs', 'scripts/*.mjs'],
      // Maestro is installed by the job; `sample`, `top` and `vm_stat` ship with macOS (run-flows.ts).
      ignoreBinaries: ['maestro', 'sample', 'top', 'vm_stat'],
      ignoreDependencies: [
        // The JSDoc type of fingerprint.config.cjs, from expo.
        '@expo/fingerprint',
        // Run by e2e/ci/repack-app.sh.
        '@expo/repack-app',
      ],
    },
    'packages/*': {
      includeEntryExports: true,
    },
    'packages/sync': {
      // Under GOOGLE_LIVE=1 only, which knip does not set.
      entry: ['src/live/**/*.live.ts'],
      // Vitest reads globalSetup's default export.
      ignoreIssues: { 'src/live/globalSetup.ts': ['exports'] },
      includeEntryExports: true,
    },
  },
} satisfies KnipConfig;
