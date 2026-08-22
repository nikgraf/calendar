import { describe, expect, it } from 'vitest';
import { retryDelayMs } from './mutations.ts';

const MINUTE = 60_000;

describe('retryDelayMs', () => {
  it('doubles from 30 seconds per attempt', () => {
    expect(retryDelayMs(0)).toBe(30_000);
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(2 * MINUTE);
    expect(retryDelayMs(3)).toBe(4 * MINUTE);
  });

  it('caps at 30 minutes so a stuck op keeps retrying at a sane rate', () => {
    expect(retryDelayMs(6)).toBe(30 * MINUTE);
    expect(retryDelayMs(20)).toBe(30 * MINUTE);
    // Never negative or NaN, however absurd the attempt count.
    expect(retryDelayMs(1000)).toBe(30 * MINUTE);
  });

  it('never goes backwards', () => {
    const delays = Array.from({ length: 12 }, (_, attempts) => retryDelayMs(attempts));
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]!).toBeGreaterThanOrEqual(delays[index - 1]!);
    }
  });
});
