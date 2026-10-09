import { describe, expect, it } from 'vite-plus/test';
import { makeRateLimiter } from './rateLimit.ts';

describe('makeRateLimiter', () => {
  it('allows the limit per window, per key, and recovers as the window slides', () => {
    let now = 1000;
    const limiter = makeRateLimiter(3, 60_000, () => now);
    expect([1, 2, 3, 4].map(() => limiter.take('a'))).toEqual([true, true, true, false]);
    // Another agent has its own budget.
    expect(limiter.take('b')).toBe(true);
    now += 59_000;
    expect(limiter.take('a')).toBe(false);
    now += 2000;
    expect(limiter.take('a')).toBe(true);
  });
});
