import { describe, expect, it } from 'vite-plus/test';
import { PILLS_SHOWN, pillTuckAfter, TUCK_DISTANCE } from './pillTuck.ts';

/** The pills after the form scrolled through `offsets`, one event each. */
const after = (offsets: ReadonlyArray<number>, max = 1000) =>
  offsets.reduce((state, offset) => pillTuckAfter(state, offset, max), PILLS_SHOWN);

describe('pillTuckAfter', () => {
  it('tucks the pills once the form is scrolled down a real distance', () => {
    expect(after([10]).tucked).toBe(false);
    expect(after([10, TUCK_DISTANCE + 1]).tucked).toBe(true);
  });

  it('brings them back on a scroll up of the same distance, not on a wavering finger', () => {
    const down = [100, 200, 300];
    expect(after([...down, 290]).tucked).toBe(true);
    expect(after([...down, 300 - TUCK_DISTANCE - 1]).tucked).toBe(false);
    // Down again from there: tucked again only after the distance.
    expect(after([...down, 270, 280]).tucked).toBe(false);
    expect(after([...down, 270, 300]).tucked).toBe(true);
  });

  it('measures from where the scroll turned, however it got there', () => {
    // Down in steps too small to count one by one.
    expect(after([10, 20, 30]).tucked).toBe(true);
    // Up in small steps from the lowest point reached.
    expect(after([100, 400, 395, 390, 385, 370]).tucked).toBe(false);
  });

  it('always shows them at the top', () => {
    expect(after([300, 0])).toEqual(PILLS_SHOWN);
  });

  it('reads a bounce past either end as no direction', () => {
    // The end is 500: the rubber band beyond it, and its way back, changes nothing.
    expect(after([200, 500, 540, 500], 500).tucked).toBe(true);
    // Above the top is the top.
    expect(after([300, -30], 500)).toEqual(PILLS_SHOWN);
  });

  it('never tucks them over a form that cannot scroll', () => {
    expect(after([40, 80], 0)).toEqual(PILLS_SHOWN);
  });
});
