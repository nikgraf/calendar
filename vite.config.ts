import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    ignorePatterns: [
      // Third-party agent skills stay byte-identical to their source.
      '.agents/',
      '.claude/',
      '.pi/',
      'coverage/',
      'dist/',
      'dist-electron/',
      'out/',
      'output/branding/',
      'apps/desktop/out/',
      'pnpm-lock.yaml',
      'apps/ios/.expo/',
      'apps/ios/ios/',
    ],
    singleQuote: true,
  },
  lint: {
    extends: [nkzw],
    ignorePatterns: [
      '.agents/',
      '.claude/',
      '.pi/',
      'coverage/',
      'dist/',
      'dist-electron/',
      'out/',
      'output/branding/',
      'apps/desktop/out/',
      'apps/ios/.expo/',
      'apps/ios/ios/',
      'vite.config.ts.timestamp-*',
    ],
    overrides: [
      {
        env: {
          browser: true,
        },
        files: ['brand/preview/*.js'],
      },
      {
        env: {
          node: true,
        },
        files: ['**/*.cjs', 'apps/ios/metro.config.js'],
        rules: {
          'typescript/no-require-imports': 'off',
        },
      },
      {
        files: ['apps/desktop/electron/**'],
        rules: {
          // Electron main logs to stdout by design.
          'no-console': 'off',
        },
      },
    ],
  },
  staged: {
    '*': 'vp check --fix',
  },
  test: {
    // A live file's beforeAll sweeps the account and creates a calendar.
    hookTimeout: process.env['GOOGLE_LIVE'] ? 120_000 : 10_000,
    // `GOOGLE_LIVE=1`: the real-account suite (packages/sync/src/live), never
    // part of `pnpm test` — it needs a refresh token and writes to Google.
    include: process.env['E2E']
      ? ['apps/desktop/e2e/**/*.e2e.ts']
      : process.env['GOOGLE_LIVE']
        ? ['packages/sync/src/live/**/*.live.ts']
        : [
            'packages/*/src/**/*.test.{ts,tsx}',
            'apps/desktop/electron/**/*.test.{ts,tsx}',
            'apps/desktop/renderer/**/*.test.{ts,tsx}',
            'apps/ios/src/**/*.test.{ts,tsx}',
          ],
    // One Electron app at a time: the spec files each launch their own,
    // and two starting together on a small CI runner raced each other
    // (lazy Electron binary download, CPU) into "CDP page target not found".
    // Live files run one at a time too: one account, and Google throttles
    // secondary-calendar creation.
    fileParallelism: !(process.env['E2E'] || process.env['GOOGLE_LIVE']),
    // One retry for the e2e specs: a runner hiccup (CDP attach, a slow
    // first paint) used to cost a full macOS job rerun. Never for live
    // files — a retry repeats real writes.
    retry: process.env['E2E'] ? 1 : 0,
    testTimeout: process.env['E2E'] ? 60_000 : process.env['GOOGLE_LIVE'] ? 120_000 : 5000,
  },
});
