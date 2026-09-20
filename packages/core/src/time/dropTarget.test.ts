import { describe, expect, it } from 'vitest';
import { type DropGeometry, dropTargetAt } from './dropTarget.ts';

// A 7-column strip 700px wide starting at x=100, of which columns 1..5 are
// on screen (a buffer column hides on each side behind the 64px gutter and
// the right edge); the lane spans y 40..88 and the grid viewport y 88..500
// with its content scrolled 360px (7.5 hours at 48px) up.
const geometry: DropGeometry = {
  columnWidth: 100,
  dayCount: 7,
  grid: { bottom: 500, top: 88 },
  gridContentTop: 88 - 360,
  hourHeight: 48,
  lane: { bottom: 88, top: 40 },
  stripLeft: 100,
};

describe('dropTargetAt', () => {
  it('lands in the lane on the column under the pointer', () => {
    expect(dropTargetAt(350, 60, geometry)).toEqual({ dayIndex: 2, kind: 'allDay' });
  });

  it('reaches the off-screen buffer columns and clamps to the strip beyond them', () => {
    expect(dropTargetAt(150, 60, geometry)).toEqual({ dayIndex: 0, kind: 'allDay' });
    expect(dropTargetAt(750, 60, geometry)).toEqual({ dayIndex: 6, kind: 'allDay' });
    expect(dropTargetAt(20, 60, geometry)).toEqual({ dayIndex: 0, kind: 'allDay' });
    expect(dropTargetAt(5000, 60, geometry)).toEqual({ dayIndex: 6, kind: 'allDay' });
  });

  it('lands in the grid at the snapped minute under the pointer', () => {
    // y=88 is the viewport top: 7.5 hours into the day. 120px lower is 10:00.
    expect(dropTargetAt(250, 88 + 120, geometry)).toEqual({
      dayIndex: 1,
      kind: 'timed',
      minute: 10 * 60,
    });
    // 5px past the hour (6 minutes) rounds down to it; 7px (9 minutes) rounds up to :15.
    expect(dropTargetAt(250, 88 + 125, geometry)).toMatchObject({ minute: 10 * 60 });
    expect(dropTargetAt(250, 88 + 127, geometry)).toMatchObject({ minute: 10 * 60 + 15 });
  });

  it('keeps the minute inside the day', () => {
    const scrolledToTop = { ...geometry, gridContentTop: 88 };
    expect(dropTargetAt(250, 88, scrolledToTop)).toMatchObject({ minute: 0 });
    const scrolledToBottom = { ...geometry, gridContentTop: 500 - 24 * 48 };
    expect(dropTargetAt(250, 499, scrolledToBottom)).toMatchObject({ minute: 23 * 60 + 45 });
  });

  it('has no target above the lane, below the grid, or before layout', () => {
    expect(dropTargetAt(250, 10, geometry)).toBeNull();
    expect(dropTargetAt(250, 600, geometry)).toBeNull();
    expect(dropTargetAt(250, 60, { ...geometry, columnWidth: 0 })).toBeNull();
  });
});
