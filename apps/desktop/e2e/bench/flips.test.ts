import { describe, expect, it } from 'vite-plus/test';
import { flipLines, namedCases, signTest } from './flips.ts';

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

  it('does not underflow for thousands of flips', () => {
    // A half to the power of 1,200 is 0 in a double: an even split must still be 1.
    expect(signTest(600, 600)).toBe(1);
    expect(signTest(700, 500)).toBeGreaterThan(0);
    expect(signTest(700, 500)).toBeLessThan(0.001);
    expect(signTest(601, 599)).toBeGreaterThan(0.9);
  });
});

describe('namedCases', () => {
  it('names the open cases and counts the blind ones', () => {
    const cases = [...flips(2, 'a'), ...flips(2, 'sealed', true)];
    expect(namedCases(cases)).toBe('a1, a2 · 2 blind');
    expect(namedCases(cases, { showBlind: true })).toBe('a1, a2, sealed1, sealed2');
    expect(namedCases(flips(1, 'sealed', true))).toBe('1 blind');
    expect(namedCases([])).toBe('');
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
      '   10 fixed, 0 broke: by chance alone p = 0.002, more than chance',
    ]);
    expect(flipLines(blind, { showBlind: true })[0]).toBe(
      '   fixed: x1, x2, x3, x4, x5, x6, x7, x8, x9, x10',
    );
  });

  it('writes a p near the line to three places, so it reads on the side it is on', () => {
    // 16 against 6 is p = 0.052: not below the line, and not printed as 0.05.
    expect(flipLines({ broke: flips(6, 'b'), fixed: flips(16, 'f') }).at(-1)).toBe(
      '   16 fixed, 6 broke: by chance alone p = 0.052, not told apart from chance',
    );
    expect(flipLines({ broke: flips(5, 'b'), fixed: flips(16, 'f') }).at(-1)).toBe(
      '   16 fixed, 5 broke: by chance alone p = 0.027, more than chance',
    );
    expect(flipLines({ broke: [], fixed: flips(20, 'f') }).at(-1)).toBe(
      '   20 fixed, 0 broke: by chance alone p < 0.001, more than chance',
    );
  });
});
