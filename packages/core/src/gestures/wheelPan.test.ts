import { describe, expect, it } from 'vitest';
import { createWheelPan, wheelDeltaToPx } from './wheelPan.ts';

const DAY = 100;

describe('wheelPan', () => {
  it('builds intent before consuming small horizontal deltas', () => {
    const pan = createWheelPan();
    expect(pan.feed(6, 0, DAY, 0).consumed).toBe(false);
    const engaged = pan.feed(6, 0, DAY, 16);
    expect(engaged.consumed).toBe(true);
    // The run-up is applied, not dropped — no dead zone at pan start.
    expect(engaged.offsetPx).toBe(-12);
  });

  it('vertical-dominant events pass through and reset intent', () => {
    const pan = createWheelPan();
    expect(pan.feed(6, 0, DAY, 0).consumed).toBe(false);
    expect(pan.feed(5, 80, DAY, 16).consumed).toBe(false);
    // Intent was reset — 6px alone stays under the threshold.
    expect(pan.feed(6, 0, DAY, 32).consumed).toBe(false);
    expect(pan.feed(6, 0, DAY, 48).consumed).toBe(true);
  });

  it('consumes vertical-dominant events while panning (2D gestures)', () => {
    const pan = createWheelPan();
    expect(pan.feed(60, 0, DAY, 0).consumed).toBe(true);
    // Mid-pan vertical movement stays consumed (the caller scrolls manually)
    // and its horizontal component keeps feeding the offset.
    const diagonal = pan.feed(2, 80, DAY, 16);
    expect(diagonal.consumed).toBe(true);
    expect(diagonal.offsetPx).toBe(-62);
  });

  it('needs fresh intent after release', () => {
    const pan = createWheelPan();
    expect(pan.feed(60, 0, DAY, 0).consumed).toBe(true);
    pan.release(DAY);
    expect(pan.feed(6, 0, DAY, 16).consumed).toBe(false);
    expect(pan.feed(6, 0, DAY, 32).consumed).toBe(true);
  });

  it('a gesture gap clears accumulated intent', () => {
    const pan = createWheelPan();
    expect(pan.feed(6, 0, DAY, 0).consumed).toBe(false);
    // > gestureGapMs later: the stale 6px run-up is gone.
    expect(pan.feed(6, 0, DAY, 400).consumed).toBe(false);
  });

  it('tracks the offset 1:1 against deltaX', () => {
    const pan = createWheelPan();
    expect(pan.feed(30, 0, DAY, 0).offsetPx).toBe(-30);
    expect(pan.feed(-10, 0, DAY, 16).offsetPx).toBe(-20);
    expect(pan.offset()).toBe(-20);
  });

  it('commits a day forward when a full day width is crossed', () => {
    const pan = createWheelPan();
    expect(pan.feed(60, 0, DAY, 0).commitDays).toBe(0);
    const crossing = pan.feed(60, 0, DAY, 16);
    expect(crossing.commitDays).toBe(1);
    // The raw offset keeps tracking the fingers until compensate().
    expect(crossing.offsetPx).toBe(-120);
    expect(pan.pendingDays()).toBe(1);
    // No double-commit while the re-anchor is still pending.
    expect(pan.feed(60, 0, DAY, 32).commitDays).toBe(0);
    expect(pan.feed(60, 0, DAY, 48).commitDays).toBe(1);
  });

  it('commits backward days for rightward panning', () => {
    const pan = createWheelPan();
    expect(pan.feed(-120, 0, DAY, 0).commitDays).toBe(-1);
    expect(pan.pendingDays()).toBe(-1);
  });

  it('compensate re-anchors the offset and clears pending days', () => {
    const pan = createWheelPan();
    pan.feed(120, 0, DAY, 0);
    expect(pan.compensate(1, DAY)).toBe(-20);
    expect(pan.pendingDays()).toBe(0);
    expect(pan.offset()).toBe(-20);
  });

  it('release snaps to the nearest day boundary', () => {
    const pan = createWheelPan();
    // 20px in: below half a day — snap back, no commit.
    pan.feed(20, 0, DAY, 0);
    expect(pan.release(DAY).commitDays).toBe(0);

    pan.reset();
    // 70px in: beyond half — commit the day being revealed.
    pan.feed(70, 0, DAY, 0);
    expect(pan.release(DAY).commitDays).toBe(1);
    expect(pan.pendingDays()).toBe(1);
    // After the renderer re-anchors, the leftover animates to 0 from +30px.
    expect(pan.compensate(1, DAY)).toBe(30);
  });

  it('release accounts for already-pending commits', () => {
    const pan = createWheelPan();
    // Crossed one day (pending), stopped 10px past the boundary.
    pan.feed(110, 0, DAY, 0);
    expect(pan.pendingDays()).toBe(1);
    expect(pan.release(DAY).commitDays).toBe(0);
  });

  it('setOffset drives settle animation frames', () => {
    const pan = createWheelPan();
    pan.feed(40, 0, DAY, 0);
    pan.setOffset(-12);
    expect(pan.offset()).toBe(-12);
  });

  it('reset clears offset, pending, and pan state', () => {
    const pan = createWheelPan();
    pan.feed(120, 0, DAY, 0);
    pan.reset();
    expect(pan.offset()).toBe(0);
    expect(pan.pendingDays()).toBe(0);
    expect(pan.feed(0, 10, DAY, 16).consumed).toBe(false);
  });

  it('wheelDeltaToPx scales line and page delta modes', () => {
    expect(wheelDeltaToPx(40, 0)).toBe(40);
    expect(wheelDeltaToPx(3, 1)).toBe(48);
    expect(wheelDeltaToPx(1, 2)).toBe(800);
  });
});
