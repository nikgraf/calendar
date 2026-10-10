import { describe, expect, it } from 'vite-plus/test';
import { Temporal } from '../time/temporal.ts';
import {
  bufferedDays,
  bufferedRange,
  NO_SLIDE,
  nextSlide,
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
  it('draws the days a slide from rest comes from on the side it comes from', () => {
    expect(nextSlide(NO_SLIDE, 3, 7)).toEqual({ lead: 3, trail: 0 });
    expect(nextSlide(NO_SLIDE, -4, 7)).toEqual({ lead: 0, trail: 4 });
  });

  it('travels the whole way up to two windows, and two windows beyond', () => {
    expect(nextSlide(NO_SLIDE, 14, 7)).toEqual({ lead: 14, trail: 0 });
    expect(nextSlide(NO_SLIDE, 40, 7)).toEqual({ lead: 14, trail: 0 });
    expect(nextSlide(NO_SLIDE, -40, 7)).toEqual({ lead: 0, trail: 14 });
    expect(nextSlide(NO_SLIDE, 5, 1)).toEqual({ lead: 2, trail: 0 });
  });

  it('keeps covering a slide still under way, wherever it has got to', () => {
    // Mon → Thu under way (lead 3), then Wed: Monday stays two days before
    // it and Thursday one day after its first day.
    expect(nextSlide({ lead: 3, trail: 0 }, -1, 7)).toEqual({ lead: 2, trail: 1 });
    // Then Fri: the strip still reaches back to Monday.
    expect(nextSlide({ lead: 3, trail: 0 }, 1, 7)).toEqual({ lead: 4, trail: 0 });
    expect(nextSlide({ lead: 14, trail: 0 }, 30, 7)).toEqual({ lead: 14, trail: 0 });
  });

  it('draws the lead before the visible days and the trail after them', () => {
    // Mon Aug 17 → Thu Aug 20: the strip starts at the old first day.
    const forward = slideSpan(MONDAY.add({ days: 3 }), 7, { lead: 3, trail: 0 });
    expect(forward.first.toString()).toBe('2026-08-17');
    expect(forward.count).toBe(10);
    const strip = bufferedDays(forward.first, forward.count, 2);
    expect(strip[2]!.toString()).toBe('2026-08-17');
    expect(strip[2 + 3]!.toString()).toBe('2026-08-20');
    const both = slideSpan(MONDAY, 7, { lead: 2, trail: 1 });
    expect(both.first.toString()).toBe('2026-08-15');
    expect(both.count).toBe(10);
  });

  it('is the visible days alone without a slide', () => {
    const span = slideSpan(MONDAY, 7, NO_SLIDE);
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
