import nkzw from '@nkzw/oxlint-config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    ignorePatterns: [
      'coverage/',
      'dist/',
      'dist-electron/',
      'out/',
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
    ],
  },
  test: {
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'packages/*/__tests__/**/*.test.{ts,tsx}',
      'apps/desktop/electron/**/*.test.ts',
    ],
  },
});
