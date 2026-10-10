import { describe, expect, it } from 'vite-plus/test';
import {
  clampSwipeOffset,
  interpolatePages,
  swipeCommitColumns,
  swipeLag,
  swipeReleaseColumns,
  swipeSnapDecision,
} from './swipeSnap.ts';

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

describe('a swipe that takes over the previous commit', () => {
  const COLUMN = 100;

  it('pans within the strip drawn around the rendered page', () => {
    // Day view (buffer 1), one navigation not drawn yet: the strip still
    // centres the previous day, so the navigated page sits one column left.
    expect(clampSwipeOffset(-150, COLUMN, 1, 1)).toBe(0);
    expect(clampSwipeOffset(150, COLUMN, 1, 1)).toBe(150);
    expect(clampSwipeOffset(250, COLUMN, 1, 1)).toBe(200);
    expect(clampSwipeOffset(-150, COLUMN, 1, 0)).toBe(-100);
  });

  it('measures the release from the navigated page and lands on a drawn column', () => {
    // A pan from a page: the plain rule.
    expect(swipeReleaseColumns(0, -60, 0, COLUMN, 1, 0)).toBe(1);
    expect(swipeReleaseColumns(0, -160, 0, COLUMN, 7, 0)).toBe(2);
    expect(swipeReleaseColumns(0, -110, 0, COLUMN, 7, 0)).toBe(1);
    expect(swipeReleaseColumns(0, 0, 0, 0, 1, 0)).toBe(0);
    // One navigation not drawn yet: the day view has no next day drawn, so
    // a further left swipe holds the page it already reached …
    expect(swipeReleaseColumns(0, -60, 0, COLUMN, 1, 1)).toBe(0);
    // … and a swipe back still goes back from the navigated page.
    expect(swipeReleaseColumns(0, 60, 0, COLUMN, 1, 1)).toBe(-1);
    expect(swipeReleaseColumns(0, 160, 0, COLUMN, 1, 1)).toBe(-2);
  });

  it('a pan that took over a commit goes the way it moved', () => {
    // 400px columns, a forward commit interrupted 20% in: navigating at
    // once rebases the strip to +320 from the new page.
    const WIDE = 400;
    // A second left flick lands on the first one's page — it used to read
    // +280 as "most of a column back" and reverse the first swipe.
    expect(swipeReleaseColumns(320, -40, -900, WIDE, 1, 1)).toBe(0);
    // A right flick takes the first swipe back.
    expect(swipeReleaseColumns(320, 40, 900, WIDE, 1, 1)).toBe(-1);
    // A touch that stops the strip settles on the nearest page.
    expect(swipeReleaseColumns(320, -5, 0, WIDE, 1, 1)).toBe(-1);
    expect(swipeReleaseColumns(80, -5, 0, WIDE, 1, 1)).toBe(0);
    // A long drag on through the week strip: the next page that way.
    expect(swipeReleaseColumns(300, -800, 0, WIDE, 7, 1)).toBe(2);
  });

  it('counts the navigated columns a render has not drawn yet', () => {
    expect(swipeLag(0, 0, COLUMN)).toBe(0);
    expect(swipeLag(COLUMN, 0, COLUMN)).toBe(1);
    expect(swipeLag(-2 * COLUMN, 0, COLUMN)).toBe(-2);
    // Drawn: the render reported the pixels the UI thread counted.
    expect(swipeLag(3 * COLUMN, 3 * COLUMN, COLUMN)).toBe(0);
    // Fractional widths summed over several swipes still give whole columns.
    expect(swipeLag(175.5 * 3 + 175.5, 175.5 * 3, 175.5)).toBe(1);
    expect(swipeLag(175.5, 175.5, 175.5)).toBe(0);
    expect(Object.is(swipeLag(-0.1, 0, COLUMN), 0)).toBe(true);
    // Not measured yet.
    expect(swipeLag(COLUMN, 0, 0)).toBe(0);
  });
});

describe('interpolatePages', () => {
  const HEIGHTS = [52, 28, 28, 76, 28];

  it("is a drawn page's own value on that page", () => {
    expect(interpolatePages(HEIGHTS, 0)).toBe(52);
    expect(interpolatePages(HEIGHTS, 2)).toBe(28);
    expect(interpolatePages(HEIGHTS, 3)).toBe(76);
  });

  it('blends between two pages as the pan crosses from one to the next', () => {
    expect(interpolatePages(HEIGHTS, 2.25)).toBe(40);
    expect(interpolatePages(HEIGHTS, 2.5)).toBe(52);
    expect(interpolatePages(HEIGHTS, 0.5)).toBe(40);
  });

  it('holds the outermost pages past the drawn strip', () => {
    expect(interpolatePages(HEIGHTS, -1)).toBe(52);
    expect(interpolatePages(HEIGHTS, 4)).toBe(28);
    expect(interpolatePages(HEIGHTS, 9)).toBe(28);
  });

  it('survives an unmeasured strip and an empty one', () => {
    expect(interpolatePages(HEIGHTS, Number.NaN)).toBe(52);
    expect(interpolatePages([], 1)).toBe(0);
    expect(interpolatePages([30], 0.5)).toBe(30);
  });
});
