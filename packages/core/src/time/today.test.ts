import { describe, expect, it } from 'vitest';
import { msUntilNextMidnight } from './today.ts';

describe('msUntilNextMidnight', () => {
  it('counts to the next local midnight in the zone', () => {
    // 2026-09-20T22:00 in Vienna (CEST, UTC+2) is 20:00Z; midnight is two hours off.
    expect(msUntilNextMidnight('Europe/Vienna', Date.parse('2026-09-20T20:00:00Z'))).toBe(
      2 * 60 * 60 * 1000,
    );
  });

  it('follows the zone through a fall-back night', () => {
    // Vienna's 2026-10-25 lasts 25 hours: from 00:30 local it is 24.5 hours to midnight.
    expect(msUntilNextMidnight('Europe/Vienna', Date.parse('2026-10-24T22:30:00Z'))).toBe(
      24.5 * 60 * 60 * 1000,
    );
  });

  it('never returns zero at exactly midnight', () => {
    expect(msUntilNextMidnight('UTC', Date.parse('2026-09-21T00:00:00Z'))).toBe(
      24 * 60 * 60 * 1000,
    );
  });
});
