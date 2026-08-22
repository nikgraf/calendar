import { describe, expect, it } from 'vitest';
import { buildMonthGrid, dayRange, daySpanRange, weekStart } from './ranges.ts';
import { Temporal } from './temporal.ts';

describe('ranges', () => {
  it('weekStart returns the Monday of the containing week', () => {
    expect(weekStart(Temporal.PlainDate.from('2026-07-02')).toString()).toBe('2026-06-29');
    expect(weekStart(Temporal.PlainDate.from('2026-06-29')).toString()).toBe('2026-06-29');
    expect(weekStart(Temporal.PlainDate.from('2026-07-05')).toString()).toBe('2026-06-29');
  });

  it('dayRange covers DST-transition days correctly', () => {
    // Europe/Vienna DST starts 2026-03-29: the day is only 23 hours long.
    const range = dayRange(Temporal.PlainDate.from('2026-03-29'), 'Europe/Vienna');
    expect((range.endUtc - range.startUtc) / (60 * 60 * 1000)).toBe(23);
  });

  it('daySpanRange spans dayCount local days from an arbitrary start', () => {
    // Rolling window anchored mid-week (Wednesday), not snapped to Monday.
    const range = daySpanRange(Temporal.PlainDate.from('2026-07-01'), 7, 'Europe/Vienna');
    expect(range.startUtc).toBe(Date.parse('2026-06-30T22:00:00Z')); // Wed 00:00 CEST
    expect(range.endUtc).toBe(Date.parse('2026-07-07T22:00:00Z'));
  });

  it('daySpanRange covers DST-transition spans correctly', () => {
    // Europe/Vienna DST starts 2026-03-29: 7 days = 167 hours.
    const range = daySpanRange(Temporal.PlainDate.from('2026-03-26'), 7, 'Europe/Vienna');
    expect((range.endUtc - range.startUtc) / (60 * 60 * 1000)).toBe(167);
  });

  it('buildMonthGrid pads to full Monday-based weeks', () => {
    const weeks = buildMonthGrid(
      Temporal.PlainYearMonth.from('2026-07'),
      Temporal.PlainDate.from('2026-07-02'),
    );
    expect(weeks).toHaveLength(5);
    expect(weeks[0]![0]!.date.toString()).toBe('2026-06-29');
    expect(weeks[0]![0]!.inMonth).toBe(false);
    expect(weeks.at(-1)![6]!.date.toString()).toBe('2026-08-02');
    const today = weeks.flat().find((day) => day.isToday);
    expect(today?.date.toString()).toBe('2026-07-02');
  });
});
