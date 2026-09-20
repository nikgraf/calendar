import { describe, expect, it } from 'vitest';
import { capAllDayLane, layoutAllDayLane } from './allDayLane.ts';

describe('layoutAllDayLane', () => {
  it('packs non-overlapping chips into one row and overlapping ones below', () => {
    const { placed, rowCount } = layoutAllDayLane(
      [
        { endDayIndex: 2, id: 'a', startDayIndex: 0 },
        { endDayIndex: 4, id: 'b', startDayIndex: 2 },
        { endDayIndex: 3, id: 'c', startDayIndex: 1 },
      ],
      7,
    );
    const rowOf = Object.fromEntries(placed.map((span) => [span.id, span.row]));
    expect(rowOf).toEqual({ a: 0, b: 0, c: 1 });
    expect(rowCount).toBe(2);
  });

  it('gives longer spans the first rows when they start on the same day', () => {
    const { placed } = layoutAllDayLane(
      [
        { endDayIndex: 1, id: 'short', startDayIndex: 0 },
        { endDayIndex: 5, id: 'long', startDayIndex: 0 },
      ],
      7,
    );
    expect(placed.map((span) => span.id)).toEqual(['long', 'short']);
    expect(placed.find((span) => span.id === 'long')?.row).toBe(0);
    expect(placed.find((span) => span.id === 'short')?.row).toBe(1);
  });

  it('clips spans to the strip and drops those entirely outside it', () => {
    const { placed, rowCount } = layoutAllDayLane(
      [
        { endDayIndex: 10, id: 'runs-past', startDayIndex: 5 },
        { endDayIndex: 2, id: 'starts-before', startDayIndex: -3 },
        { endDayIndex: 9, id: 'outside', startDayIndex: 8 },
      ],
      7,
    );
    expect(placed.map((span) => [span.id, span.startDayIndex, span.endDayIndex])).toEqual([
      ['starts-before', 0, 2],
      ['runs-past', 5, 7],
    ]);
    expect(rowCount).toBe(1);
  });

  it('is empty for no spans', () => {
    expect(layoutAllDayLane([], 7)).toEqual({ placed: [], rowCount: 0 });
  });
});

const oneDay = (id: string, day: number, row: number) => ({
  endDayIndex: day + 1,
  id,
  row,
  startDayIndex: day,
});

describe('capAllDayLane', () => {
  it('hides nothing when the lane fits the cap', () => {
    const placed = [oneDay('a', 0, 0), oneDay('b', 0, 1), oneDay('c', 0, 2), oneDay('d', 3, 0)];
    expect(capAllDayLane(placed, 7, 3)).toEqual({
      moreByDay: [0, 0, 0, 0, 0, 0, 0],
      rowCount: 3,
      visible: placed,
    });
  });

  it('gives an overflowing column its last row to the "+N more" chip', () => {
    const placed = [
      oneDay('a', 2, 0),
      oneDay('b', 2, 1),
      oneDay('c', 2, 2),
      oneDay('d', 2, 3),
      oneDay('e', 2, 4),
      oneDay('f', 4, 2),
    ];
    const capped = capAllDayLane(placed, 7, 3);
    expect(capped.visible.map((span) => span.id)).toEqual(['a', 'b', 'f']);
    expect(capped.moreByDay).toEqual([0, 0, 3, 0, 0, 0, 0]);
    expect(capped.rowCount).toBe(3);
  });

  it('hides a multi-day chip on the cap row once any covered column overflows, counting it in each', () => {
    const placed = [
      { endDayIndex: 5, id: 'long', row: 2, startDayIndex: 1 },
      oneDay('a', 3, 0),
      oneDay('b', 3, 1),
      oneDay('c', 3, 3),
    ];
    const capped = capAllDayLane(placed, 7, 3);
    expect(capped.visible.map((span) => span.id)).toEqual(['a', 'b']);
    expect(capped.moreByDay).toEqual([0, 1, 1, 2, 1, 0, 0]);
  });

  it('always hides a chip packed below the cap, even where no column is over it', () => {
    // Greedy packing can leave a chip on row 3 whose columns hold three
    // chips each; the "+N more" it needs still evicts the row-2 chip there.
    const placed = [oneDay('a', 0, 0), oneDay('b', 0, 1), oneDay('c', 0, 2), oneDay('d', 0, 3)];
    const capped = capAllDayLane(placed, 7, 3);
    expect(capped.visible.map((span) => span.id)).toEqual(['a', 'b']);
    expect(capped.moreByDay[0]).toBe(2);
  });

  it('is empty for an empty lane', () => {
    expect(capAllDayLane([], 3, 3)).toEqual({ moreByDay: [0, 0, 0], rowCount: 0, visible: [] });
  });
});
