import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'vite-plus';

// A function's cyclomatic complexity stops at 40 (`complexity` below).
// These files held larger ones when the cap arrived. Each lists its
// functions over 40, highest first: the file's rule allows the highest,
// and `scripts/complexityPins.test.ts` holds the file to exactly these
// numbers (by value: it does not know which function is which), so
// nothing else in it passes 40. A list only shrinks: lower a number when
// its function shrinks, drop it at 40. Never raise or add one — split
// the function instead, into pieces of 40 or less. A function that moves
// to another file takes its number along; an oxlint upgrade that counts
// differently re-measures them in its own PR.
export const complexityCap = 40;
export const complexityPins: Record<string, ReadonlyArray<number>> = {
  'apps/desktop/e2e/bench/check.ts': [77],
  'packages/agent/src/ops/events.ts': [52],
  'packages/ai/src/grounding.ts': [74],
  'packages/ai/src/normalizeQuickAdd.ts': [80, 42],
  'packages/ai/src/refine.ts': [62],
  'packages/app-state/src/editorModel.ts': [73, 56],
  'packages/app-state/src/taskEditorModel.ts': [56],
  'packages/sync/src/mutations.ts': [57],
  'packages/sync/src/settingsImport.ts': [45],
};

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
        env: { node: true },
        files: ['apps/web/**/*.astro'],
        globals: { Astro: 'readonly' },
      },
      {
        env: {
          browser: true,
        },
        // The brand preview's script and the website's inline head script.
        files: ['brand/preview/*.js', 'apps/web/src/inline/*.js'],
      },
      {
        env: {
          node: true,
        },
        files: ['**/*.cjs', 'apps/ios/app.config.js', 'apps/ios/metro.config.js'],
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
      {
        // The dictation worklet runs in an AudioWorkletGlobalScope:
        // registerProcessor and AudioWorkletProcessor are its globals.
        files: ['apps/desktop/public/*.worklet.js'],
        globals: { AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly' },
      },
      {
        // Maestro runScript files: GraalJS with `http`, `json`, `output`
        // and every flow/env variable as bare globals.
        files: ['apps/ios/e2e/live/scripts/*.js'],
        rules: {
          'no-undef': 'off',
        },
      },
      {
        env: {
          node: true,
        },
        // Repo CLI scripts talk through stdout/stderr by design.
        files: ['scripts/*.mjs', 'scripts/*.ts'],
        rules: {
          'no-console': 'off',
        },
      },
      ...Object.entries(complexityPins).map(([file, pins]) => ({
        files: [file],
        rules: {
          complexity: ['error', { max: Math.max(complexityCap, ...pins) }] satisfies [
            'error',
            { max: number },
          ],
        },
      })),
    ],
    rules: {
      complexity: ['error', { max: complexityCap }],
    },
  },
  staged: {
    '*': 'vp check --fix',
  },
  test: {
    // The live run's shared scratch calendars and lists, created once (Google
    // caps calendar creation per account and day).
    globalSetup: process.env['GOOGLE_LIVE'] ? ['packages/sync/src/live/globalSetup.ts'] : [],
    hookTimeout: process.env['GOOGLE_LIVE'] ? 120_000 : 10_000,
    // `GOOGLE_LIVE=1`: the real-account suite (packages/sync/src/live), never
    // part of `pnpm test` — it needs a refresh token and writes to Google.
    include: process.env['E2E']
      ? ['apps/desktop/e2e/**/*.e2e.ts']
      : process.env['GOOGLE_LIVE']
        ? ['packages/sync/src/live/**/*.live.ts']
        : [
            'packages/*/src/**/*.test.{ts,tsx}',
            'apps/desktop/e2e/bench/**/*.test.ts',
            'apps/desktop/electron/**/*.test.{ts,tsx}',
            'apps/desktop/renderer/**/*.test.{ts,tsx}',
            'apps/ios/src/**/*.test.{ts,tsx}',
            'apps/ios/e2e/ci/**/*.test.ts',
            'apps/web/{scripts,src}/**/*.test.{ts,tsx}',
            'scripts/**/*.test.ts',
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
    testTimeout: process.env['E2E'] ? 60_000 : process.env['GOOGLE_LIVE'] ? 300_000 : 5000,
  },
});
