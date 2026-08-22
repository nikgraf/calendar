import { describe, expect, it } from 'vitest';
import { swipeSnapDecision } from './swipeSnap.ts';

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
