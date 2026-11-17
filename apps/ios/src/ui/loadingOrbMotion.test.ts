import { describe, expect, it } from 'vite-plus/test';
import {
  breath,
  dotLook,
  letterOpacity,
  ORB_DOTS as dots,
  orbDot,
  orbOpacity,
  SWEEPS,
} from './loadingOrbMotion.ts';
const phases = Array.from({ length: 41 }, (_, n) => n / 40);
const letters = Array.from({ length: 22 }, (_, n) => (n + 0.5) / 22);

/** The letter the band lifts most at `phase`. */
const brightest = (phase: number) => {
  const drawn = letters.map((at) => letterOpacity(at, phase, false));
  return drawn.indexOf(Math.max(...drawn));
};

describe('orbDot', () => {
  it('keeps every dot on the orb', () => {
    for (const phase of phases) {
      for (const { index, ring } of dots) {
        const { depth, x, y } = orbDot(ring, index, phase, false);
        expect(Math.hypot(x, y, depth)).toBeCloseTo(1, 9);
      }
    }
  });

  it('draws the same at the end of the loop as at its start', () => {
    for (const { index, ring } of dots) {
      const start = orbDot(ring, index, 0, false);
      const end = orbDot(ring, index, 1, false);
      expect(end.x).toBeCloseTo(start.x, 9);
      expect(end.y).toBeCloseTo(start.y, 9);
      expect(end.depth).toBeCloseTo(start.depth, 9);
    }
  });

  it('moves the dots while the loop runs', () => {
    const start = orbDot(0, 0, 0, false);
    const later = orbDot(0, 0, 0.1, false);
    expect(Math.hypot(later.x - start.x, later.y - start.y)).toBeGreaterThan(0.1);
  });

  it('holds the dots still under Reduce Motion, apart from each other', () => {
    for (const { index, ring } of dots) {
      expect(orbDot(ring, index, 0.6, true)).toEqual(orbDot(ring, index, 0, true));
    }
    const drawn = dots.map(({ index, ring }) => orbDot(ring, index, 0, true));
    for (const [n, dot] of drawn.entries()) {
      for (const other of drawn.slice(n + 1)) {
        expect(
          Math.hypot(dot.x - other.x, dot.y - other.y, dot.depth - other.depth),
        ).toBeGreaterThan(0.05);
      }
    }
  });
});

describe('dotLook', () => {
  it('draws a nearer dot larger and brighter', () => {
    const far = dotLook(-1);
    const near = dotLook(1);
    expect(near.opacity).toBe(1);
    expect(near.scale).toBe(1);
    expect(far.opacity).toBeLessThan(near.opacity);
    expect(far.scale).toBeLessThan(near.scale);
    expect(far.opacity).toBeGreaterThan(0);
  });
});

describe('letterOpacity', () => {
  it('lifts the letters under the band to full and leaves the rest dim', () => {
    const drawn = letters.map((at) => letterOpacity(at, 0.5 / SWEEPS, false));
    expect(Math.max(...drawn)).toBeGreaterThan(0.95);
    expect(Math.min(...drawn)).toBeCloseTo(0.4, 9);
  });

  it('sweeps from the first letter to the last', () => {
    expect(brightest(0.3 / SWEEPS)).toBeLessThan(brightest(0.5 / SWEEPS));
    expect(brightest(0.5 / SWEEPS)).toBeLessThan(brightest(0.7 / SWEEPS));
  });

  it('jumps no letter at the seams between sweeps', () => {
    for (const seam of [0, 1 / SWEEPS, 1]) {
      for (const at of letters) {
        expect(letterOpacity(at, seam, false)).toBeCloseTo(0.4, 9);
      }
    }
  });

  it('breathes every letter together under Reduce Motion', () => {
    for (const phase of phases) {
      const drawn = letters.map((at) => letterOpacity(at, phase, true));
      expect(new Set(drawn).size).toBe(1);
    }
    expect(letterOpacity(0.5, 0, true)).toBeCloseTo(0.4, 9);
    expect(letterOpacity(0.5, 0.5 / SWEEPS, true)).toBeCloseTo(1, 9);
  });
});

describe('orbOpacity', () => {
  it('stays whole while the dots move and breathes under Reduce Motion', () => {
    expect(phases.every((phase) => orbOpacity(phase, false) === 1)).toBe(true);
    expect(orbOpacity(0, true)).toBeCloseTo(0.55, 9);
    expect(orbOpacity(0.5 / SWEEPS, true)).toBeCloseTo(1, 9);
    expect(breath(1)).toBeCloseTo(breath(0), 9);
  });
});
