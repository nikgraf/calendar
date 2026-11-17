import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

describe('the launch configuration', () => {
  const config = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'app.json'), 'utf8')) as {
    expo: {
      updates: { fallbackToCacheTimeout: number };
    };
  };

  it('never holds a launch for an update: one found at launch runs from the next', () => {
    expect(config.expo.updates.fallbackToCacheTimeout).toBe(0);
  });
});
