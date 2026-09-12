import { describe, expect, it } from 'vitest';
import { layoutAllDayLane } from './allDayLane.ts';

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
