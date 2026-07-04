import { describe, expect, it } from 'vitest';
import { applyWallClockDelta, moveEventTimes, resizeEventEnd, snapMinutes } from './dragMath.ts';

const HOUR = 60 * 60 * 1000;
const event = {
  endUtc: Date.parse('2026-07-03T11:00:00Z'),
  startUtc: Date.parse('2026-07-03T10:00:00Z'),
};

describe('dragMath', () => {
  it('snaps to 15-minute steps, rounding to nearest', () => {
    expect(snapMinutes(0)).toBe(0);
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(22)).toBe(15);
    expect(snapMinutes(23)).toBe(30);
    expect(snapMinutes(-8)).toBe(-15);
    expect(snapMinutes(-7)).toBe(-0);
  });

  it('moves preserving duration, snapped', () => {
    const moved = moveEventTimes(event, 37); // snaps to 30
    expect(moved.startUtc).toBe(Date.parse('2026-07-03T10:30:00Z'));
    expect(moved.endUtc - moved.startUtc).toBe(HOUR);
  });

  it('moves across days and backwards', () => {
    const moved = moveEventTimes(event, -30, 2);
    expect(moved.startUtc).toBe(Date.parse('2026-07-05T09:30:00Z'));
    expect(moved.endUtc - moved.startUtc).toBe(HOUR);
  });

  it('resizes the end with snapping', () => {
    expect(resizeEventEnd(event, 44).endUtc).toBe(Date.parse('2026-07-03T11:45:00Z'));
  });

  it('clamps resize to the minimum duration', () => {
    expect(resizeEventEnd(event, -3 * 60).endUtc).toBe(event.startUtc + 15 * 60 * 1000);
  });
});

describe('DST-aware shifts', () => {
  // Europe/Vienna springs forward on 2026-03-29 (+01:00 -> +02:00).
  it('keeps the wall-clock time when dragging across the spring-forward day', () => {
    const moved = moveEventTimes(
      {
        // Sat Mar 28, 09:00 Vienna (+01:00)
        endUtc: Date.parse('2026-03-28T09:00:00Z'),
        startTimeZone: 'Europe/Vienna',
        startUtc: Date.parse('2026-03-28T08:00:00Z'),
      },
      0,
      1,
    );
    // Sun Mar 29, 09:00 Vienna is +02:00 -> 07:00Z.
    expect(moved.startUtc).toBe(Date.parse('2026-03-29T07:00:00Z'));
    expect(moved.endUtc - moved.startUtc).toBe(60 * 60 * 1000);
  });

  it('falls back to instant math without a zone', () => {
    const moved = moveEventTimes(
      { endUtc: Date.parse('2026-03-28T09:00:00Z'), startUtc: Date.parse('2026-03-28T08:00:00Z') },
      0,
      1,
    );
    expect(moved.startUtc).toBe(Date.parse('2026-03-29T08:00:00Z'));
  });

  it('applies a wall-clock series delta across DST regimes', () => {
    // The occurrence moved Mar 28 09:00 -> Mar 30 09:00 Vienna (2 wall days,
    // but 46 absolute hours because of the transition in between).
    const shifted = applyWallClockDelta(
      // Series start: Jun 1, 09:00 Vienna (+02:00).
      Date.parse('2026-06-01T07:00:00Z'),
      'Europe/Vienna',
      Date.parse('2026-03-28T08:00:00Z'),
      Date.parse('2026-03-30T07:00:00Z'),
    );
    // Wall delta is exactly +2 days: Jun 3, 09:00 Vienna.
    expect(shifted).toBe(Date.parse('2026-06-03T07:00:00Z'));
  });

  it('applies pure time-of-day deltas', () => {
    const shifted = applyWallClockDelta(
      Date.parse('2026-01-05T08:00:00Z'), // Jan 5, 09:00 Vienna (+01:00)
      'Europe/Vienna',
      Date.parse('2026-07-06T07:00:00Z'), // Jul 6, 09:00 Vienna (+02:00)
      Date.parse('2026-07-06T08:30:00Z'), // -> 10:30
    );
    expect(shifted).toBe(Date.parse('2026-01-05T09:30:00Z')); // Jan 5, 10:30 Vienna
  });
});
