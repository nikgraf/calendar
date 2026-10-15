import { describe, expect, it } from 'vite-plus/test';
import { EDGE_SCROLL_IDLE, type EdgeScrollState, edgeScrollStep } from './edgeScroll.ts';

const VIEWPORT = { bottom: 600, top: 100 };
const ZONE = 40;
const MAX = 400;
const ARMED: EdgeScrollState = { armedBottom: true, armedTop: true };

const step = (state: EdgeScrollState, y: number) => edgeScrollStep(state, y, VIEWPORT, ZONE, MAX);

/** Runs a pointer path from the idle state; the last step's result. */
const along = (...ys: Array<number>) => {
  let state = EDGE_SCROLL_IDLE;
  let velocity = 0;
  for (const y of ys) {
    ({ state, velocity } = step(state, y));
  }
  return { state, velocity };
};

describe('edgeScrollStep', () => {
  it('stands still in the middle of the grid', () => {
    expect(step(ARMED, 350).velocity).toBe(0);
    expect(step(ARMED, 140).velocity).toBe(0);
    expect(step(ARMED, 560).velocity).toBe(0);
  });

  it('ramps up quadratically toward each edge', () => {
    expect(step(ARMED, 580).velocity).toBeCloseTo(MAX / 4);
    expect(step(ARMED, 600).velocity).toBeCloseTo(MAX);
    expect(step(ARMED, 120).velocity).toBeCloseTo(-MAX / 4);
    expect(step(ARMED, 100).velocity).toBeCloseTo(-MAX);
  });

  it('scrolls at full speed past the bottom edge', () => {
    expect(step(ARMED, 900).velocity).toBe(MAX);
  });

  it('never scrolls above the top edge, where the all-day lane is', () => {
    expect(step(ARMED, 99).velocity).toBe(0);
    expect(step(ARMED, 0).velocity).toBe(0);
  });

  it('does not scroll up while a lane chip crosses the top zone on its way in', () => {
    const entering = along(80, 105, 120, 135);
    expect(entering.velocity).toBe(0);
    expect(entering.state.armedTop).toBe(false);
    // Once it has been in the grid, back up to the edge scrolls.
    expect(along(80, 120, 200, 110).velocity).toBeLessThan(0);
  });

  it('waits for a press inside a zone to leave it before that edge scrolls', () => {
    expect(along(590, 595, 600).velocity).toBe(0);
    expect(along(590, 500, 595).velocity).toBeGreaterThan(0);
    // The other edge is armed from the start.
    expect(along(590, 110).velocity).toBeLessThan(0);
  });

  it('keeps the state object while nothing new is armed', () => {
    const { state } = along(300);
    expect(step(state, 350).state).toBe(state);
  });

  it('shrinks the zones to a third of a short viewport', () => {
    const short = { bottom: 160, top: 100 };
    expect(edgeScrollStep(ARMED, 130, short, ZONE, MAX).velocity).toBe(0);
    expect(edgeScrollStep(ARMED, 160, short, ZONE, MAX).velocity).toBeCloseTo(MAX);
    expect(edgeScrollStep(ARMED, 100, short, ZONE, MAX).velocity).toBeCloseTo(-MAX);
  });

  it('does nothing without a viewport or a zone', () => {
    expect(edgeScrollStep(ARMED, 100, { bottom: 100, top: 100 }, ZONE, MAX).velocity).toBe(0);
    expect(edgeScrollStep(ARMED, 600, VIEWPORT, 0, MAX).velocity).toBe(0);
  });
});
