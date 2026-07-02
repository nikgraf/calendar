import { describe, expect, it } from 'vitest';
import { layoutAllDayLane } from './allDayLane.ts';
import { layoutDayColumn } from './dayGrid.ts';

const HOUR = 60 * 60 * 1000;
const DAY_START = 0;
const DAY_END = 24 * HOUR;

const box = (id: string, startHour: number, endHour: number) => ({
  endUtc: endHour * HOUR,
  id,
  startUtc: startHour * HOUR,
});

describe('layoutDayColumn', () => {
  it('gives a lone event the full width', () => {
    const [placed] = layoutDayColumn([box('a', 9, 10)], DAY_START, DAY_END);
    expect(placed).toEqual({
      height: 1 / 24,
      id: 'a',
      left: 0,
      top: 9 / 24,
      width: 1,
    });
  });

  it('splits two overlapping events into half-width columns', () => {
    const placed = layoutDayColumn([box('a', 9, 11), box('b', 10, 12)], DAY_START, DAY_END);
    expect(placed.find((entry) => entry.id === 'a')).toMatchObject({
      left: 0,
      width: 0.5,
    });
    expect(placed.find((entry) => entry.id === 'b')).toMatchObject({
      left: 0.5,
      width: 0.5,
    });
  });

  it('reuses freed columns within a cluster', () => {
    // Equal starts sort longest-first: b(9–12) takes column 0, a(9–10)
    // column 1; when a ends, c(10–11) reuses a's freed column.
    const placed = layoutDayColumn(
      [box('a', 9, 10), box('b', 9, 12), box('c', 10, 11)],
      DAY_START,
      DAY_END,
    );
    const byId = Object.fromEntries(placed.map((entry) => [entry.id, entry]));
    expect(byId['b']).toMatchObject({ left: 0, width: 0.5 });
    expect(byId['a']).toMatchObject({ left: 0.5, width: 0.5 });
    expect(byId['c']).toMatchObject({ left: 0.5, width: 0.5 });
  });

  it('keeps separate clusters full width', () => {
    const placed = layoutDayColumn([box('a', 9, 10), box('b', 14, 15)], DAY_START, DAY_END);
    expect(placed.every((entry) => entry.width === 1)).toBe(true);
  });

  it('clips events crossing the day boundary', () => {
    const placed = layoutDayColumn([box('a', -2, 2)], DAY_START, DAY_END);
    expect(placed[0]).toMatchObject({ height: 2 / 24, top: 0 });
  });
});

describe('layoutAllDayLane', () => {
  it('packs non-overlapping spans into one row', () => {
    const { placed, rowCount } = layoutAllDayLane(
      [
        { endDayIndex: 2, id: 'a', startDayIndex: 0 },
        { endDayIndex: 5, id: 'b', startDayIndex: 2 },
      ],
      7,
    );
    expect(rowCount).toBe(1);
    expect(placed.every((entry) => entry.row === 0)).toBe(true);
  });

  it('stacks overlapping spans and clips to the window', () => {
    const { placed, rowCount } = layoutAllDayLane(
      [
        { endDayIndex: 9, id: 'long', startDayIndex: -3 },
        { endDayIndex: 3, id: 'mid', startDayIndex: 1 },
        { endDayIndex: 4, id: 'third', startDayIndex: 2 },
      ],
      7,
    );
    expect(rowCount).toBe(3);
    const long = placed.find((entry) => entry.id === 'long');
    expect(long).toMatchObject({ endDayIndex: 7, row: 0, startDayIndex: 0 });
  });
});
