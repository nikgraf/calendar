import { describe, expect, it } from 'vite-plus/test';
import { flipLines, signTest } from './flips.ts';

const flips = (count: number, prefix: string, blind = false) =>
  Array.from({ length: count }, (_, index) => ({ blind, id: `${prefix}${String(index + 1)}` }));

describe('signTest', () => {
  it('is 1 for an even split and for no flips at all', () => {
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(7, 7)).toBe(1);
    // 8 against 7 of 15: nearly a coin's own split.
    expect(signTest(8, 7)).toBe(1);
  });

  it('is the chance of a split at least this uneven, either way round', () => {
    // 12 of 16: 2 × (1820 + 560 + 120 + 16 + 1) / 65536.
    expect(signTest(12, 4)).toBeCloseTo(5034 / 65_536, 10);
    expect(signTest(4, 12)).toBeCloseTo(5034 / 65_536, 10);
    // Ten of ten: 2 / 1024.
    expect(signTest(10, 0)).toBeCloseTo(2 / 1024, 12);
    expect(signTest(1, 0)).toBe(1);
  });

  it('stays a probability for a bench of hundreds of cases', () => {
    const p = signTest(180, 120);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.001);
  });
});

describe('flipLines', () => {
  it('prints nothing when no case flipped', () => {
    expect(flipLines({ broke: [], fixed: [] })).toEqual([]);
  });

  it('names the open cases, counts the blind ones, and says what chance would do', () => {
    expect(
      flipLines({
        broke: [...flips(1, 'b'), ...flips(1, 'hidden', true)],
        fixed: [...flips(2, 'f'), ...flips(3, 'hidden', true)],
      }),
    ).toEqual([
      '   fixed: f1, f2 · 3 blind',
      '   broke: b1 · 1 blind',
      '   5 fixed, 2 broke: by chance alone p = 0.45, not told apart from chance',
    ]);
  });

  it('leaves out a side without flips and names blind cases only when asked to', () => {
    const blind = { broke: [], fixed: flips(10, 'x', true) };
    expect(flipLines(blind)).toEqual([
      '   fixed: 10 blind',
      '   10 fixed, 0 broke: by chance alone p < 0.01, more than chance',
    ]);
    expect(flipLines(blind, { showBlind: true })[0]).toBe(
      '   fixed: x1, x2, x3, x4, x5, x6, x7, x8, x9, x10',
    );
  });
});
