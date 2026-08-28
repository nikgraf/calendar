import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    ignorePatterns: [
      'coverage/',
      'dist/',
      'dist-electron/',
      'out/',
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
      'coverage/',
      'dist/',
      'dist-electron/',
      'out/',
      'apps/desktop/out/',
      'apps/ios/.expo/',
      'apps/ios/ios/',
      'vite.config.ts.timestamp-*',
    ],
    overrides: [
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
  test: {
    include: process.env['E2E']
      ? ['apps/desktop/e2e/**/*.e2e.ts']
      : [
          'packages/*/src/**/*.test.{ts,tsx}',
          'apps/desktop/electron/**/*.test.{ts,tsx}',
          'apps/desktop/renderer/**/*.test.{ts,tsx}',
          'apps/ios/src/**/*.test.{ts,tsx}',
        ],
    testTimeout: process.env['E2E'] ? 60_000 : 5000,
  },
});
