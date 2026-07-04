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
  resolve: {
    alias: {
      // The root better-sqlite3 is compiled for Electron's ABI; tests run
      // under system Node and use this Node-ABI copy instead.
      'better-sqlite3': 'better-sqlite3-node',
    },
  },
  test: {
    include: process.env['E2E']
      ? ['apps/desktop/e2e/**/*.e2e.ts']
      : [
          'packages/*/src/**/*.test.{ts,tsx}',
          'packages/*/__tests__/**/*.test.{ts,tsx}',
          'apps/desktop/electron/**/*.test.ts',
        ],
    server: {
      deps: {
        // Must be processed by vite so the better-sqlite3 alias applies.
        inline: ['@effect/sql-sqlite-node'],
      },
    },
    testTimeout: process.env['E2E'] ? 60_000 : 5000,
  },
});
