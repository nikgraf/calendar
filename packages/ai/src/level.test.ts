import { describe, expect, it } from 'vite-plus/test';
import { levelOf } from './level.ts';

describe('levelOf', () => {
  it('reads a full-scale square wave as 0 dBFS', () => {
    expect(levelOf([1, -1, 1, -1])).toBeCloseTo(0);
  });

  it('reads a tenth of full scale as -20 dBFS', () => {
    expect(levelOf(new Float32Array(160).fill(0.1))).toBeCloseTo(-20, 3);
  });

  it('reads digital silence and an empty block as -Infinity', () => {
    expect(levelOf(new Float32Array(128))).toBe(Number.NEGATIVE_INFINITY);
    expect(levelOf([])).toBe(Number.NEGATIVE_INFINITY);
  });
});
