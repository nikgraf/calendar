import { describe, expect, it } from 'vitest';
import { moveEventTimes, resizeEventEnd, snapMinutes } from './dragMath.ts';

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
