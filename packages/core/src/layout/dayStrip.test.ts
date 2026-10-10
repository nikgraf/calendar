import { describe, expect, it } from 'vite-plus/test';
import { Temporal } from '../time/temporal.ts';
import {
  bufferedDays,
  bufferedRange,
  clampSlide,
  pageMaxima,
  slideSpan,
  TWO_DAY_SWIPE_BUFFER,
} from './dayStrip.ts';

const MONDAY = Temporal.PlainDate.from('2026-08-17');

describe('dayStrip', () => {
  it('surrounds the visible days with buffer neighbours', () => {
    expect(bufferedDays(MONDAY, 1, 1).map(String)).toEqual([
      '2026-08-16',
      '2026-08-17',
      '2026-08-18',
    ]);
    expect(bufferedDays(MONDAY, 7, 2)).toHaveLength(11);
    expect(bufferedDays(MONDAY, 7, 2)[0]!.toString()).toBe('2026-08-15');
  });

  it('gives the two-day view a full page of drawn neighbours on each side', () => {
    const strip = bufferedDays(MONDAY, 2, TWO_DAY_SWIPE_BUFFER);
    expect(strip).toHaveLength(6);
    expect(strip[0]!.toString()).toBe('2026-08-15');
    expect(strip.at(-1)!.toString()).toBe('2026-08-20');
  });

  it('renders only the visible days when there is no buffer', () => {
    expect(bufferedDays(MONDAY, 7, 0).map(String)[0]).toBe('2026-08-17');
    expect(bufferedDays(MONDAY, 7, 0)).toHaveLength(7);
  });

  it('covers exactly the rendered days in the fetch range', () => {
    const days = bufferedDays(MONDAY, 7, 2);
    const range = bufferedRange(MONDAY, 7, 2, 'Europe/Vienna');
    const firstStart = days[0]!.toZonedDateTime({ timeZone: 'Europe/Vienna' }).startOfDay();
    const afterLast = days
      .at(-1)!
      .add({ days: 1 })
      .toZonedDateTime({ timeZone: 'Europe/Vienna' })
      .startOfDay();
    expect(range.startUtc).toBe(firstStart.toInstant().epochMilliseconds);
    expect(range.endUtc).toBe(afterLast.toInstant().epochMilliseconds);
  });
});

describe('slides', () => {
  it('travels the whole way up to two windows, and two windows beyond', () => {
    expect(clampSlide(3, 7)).toBe(3);
    expect(clampSlide(-14, 7)).toBe(-14);
    expect(clampSlide(40, 7)).toBe(14);
    expect(clampSlide(-40, 7)).toBe(-14);
    expect(clampSlide(5, 1)).toBe(2);
  });

  it('draws the days a forward slide comes from before the visible ones', () => {
    // Mon Aug 17 → Thu Aug 20: the strip starts at the old first day.
    const span = slideSpan(MONDAY.add({ days: 3 }), 7, 3);
    expect(span.first.toString()).toBe('2026-08-17');
    expect(span.count).toBe(10);
    const strip = bufferedDays(span.first, span.count, 2);
    expect(strip[2]!.toString()).toBe('2026-08-17');
    expect(strip[2 + 3]!.toString()).toBe('2026-08-20');
  });

  it('draws the days a backward slide comes from after the visible ones', () => {
    const span = slideSpan(MONDAY, 7, -4);
    expect(span.first.toString()).toBe('2026-08-17');
    expect(span.count).toBe(11);
    // The old window, Fri Aug 21 – Thu Aug 27, is the span's tail.
    expect(span.first.add({ days: span.count - 7 }).toString()).toBe('2026-08-21');
  });

  it('is the visible days alone without a slide', () => {
    const span = slideSpan(MONDAY, 7, 0);
    expect(span.first.toString()).toBe('2026-08-17');
    expect(span.count).toBe(7);
  });
});

describe('pageMaxima', () => {
  it("gives each page the strip can show its busiest day's value", () => {
    // The two-day view: six drawn days, five pages, the visible one third.
    expect(pageMaxima([2, 0, 0, 0, 3, 1], 2)).toEqual([2, 0, 0, 3, 3]);
    // The day view: each day is its own page.
    expect(pageMaxima([1, 4, 0], 1)).toEqual([1, 4, 0]);
    expect(pageMaxima([1, 4, 0, 2, 0, 0, 1, 0, 0], 7)).toEqual([4, 4, 2]);
  });

  it('has no page when the strip is shorter than one', () => {
    expect(pageMaxima([1], 2)).toEqual([]);
    expect(pageMaxima([], 1)).toEqual([]);
  });
});
