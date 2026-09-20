import { describe, expect, it } from 'vitest';
import { swipeCommitColumns, swipeSnapDecision } from './swipeSnap.ts';

const WIDTH = 400;

describe('swipeSnapDecision', () => {
  it('springs back for a short slow drag', () => {
    expect(swipeSnapDecision(-40, 0, WIDTH)).toBe(0);
  });

  it('advances once past a quarter of the column', () => {
    expect(swipeSnapDecision(-101, 0, WIDTH)).toBe(1);
    expect(swipeSnapDecision(101, 0, WIDTH)).toBe(-1);
  });

  it('advances on a fast flick that barely moved', () => {
    expect(swipeSnapDecision(-20, -900, WIDTH)).toBe(1);
    expect(swipeSnapDecision(20, 900, WIDTH)).toBe(-1);
  });

  it('ignores a fast flick below the minimum travel (a tap wobble)', () => {
    expect(swipeSnapDecision(-4, -2000, WIDTH)).toBe(0);
  });

  it('never commits before the column has been measured', () => {
    expect(swipeSnapDecision(-300, -2000, 0)).toBe(0);
  });

  it('treats a motionless release as no decision', () => {
    expect(swipeSnapDecision(0, 0, WIDTH)).toBe(0);
  });

  it('honours an overridden threshold', () => {
    expect(swipeSnapDecision(-60, 0, WIDTH)).toBe(0);
    expect(swipeSnapDecision(-60, 0, WIDTH, { commitFraction: 0.1 })).toBe(1);
  });
});

describe('swipeCommitColumns', () => {
  const COLUMN = 50;

  it('is swipeSnapDecision when one column is the whole page', () => {
    for (const [translation, velocity] of [
      [-40, 0],
      [-101, 0],
      [101, 0],
      [-20, -900],
      [-4, -2000],
      [0, 0],
    ] as const) {
      expect(swipeCommitColumns(translation, velocity, WIDTH, 1)).toBe(
        swipeSnapDecision(translation, velocity, WIDTH),
      );
    }
    expect(swipeCommitColumns(-900, 0, WIDTH, 1)).toBe(1);
  });

  it('commits the whole columns crossed plus the quarter rule on the rest', () => {
    expect(swipeCommitColumns(-1.6 * COLUMN, 0, COLUMN, 7)).toBe(2);
    expect(swipeCommitColumns(-1.1 * COLUMN, 0, COLUMN, 7)).toBe(1);
    expect(swipeCommitColumns(2.2 * COLUMN, 0, COLUMN, 7)).toBe(-2);
    expect(swipeCommitColumns(2.3 * COLUMN, 0, COLUMN, 7)).toBe(-3);
  });

  it('lets a flick add one more column past those crossed', () => {
    expect(swipeCommitColumns(-1.2 * COLUMN, -900, COLUMN, 7)).toBe(2);
    // ...but not from a wobble below the minimum travel.
    expect(swipeCommitColumns(-1.1 * COLUMN, -900, COLUMN, 7)).toBe(1);
  });

  it('never commits past the drawn buffer', () => {
    expect(swipeCommitColumns(-9 * COLUMN, -2000, COLUMN, 7)).toBe(7);
    expect(swipeCommitColumns(9 * COLUMN, 0, COLUMN, 7)).toBe(-7);
  });

  it('commits nothing before the column has been measured', () => {
    expect(swipeCommitColumns(-300, -2000, 0, 7)).toBe(0);
  });
});
