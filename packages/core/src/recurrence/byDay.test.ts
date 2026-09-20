import { describe, expect, it } from 'vitest';
import {
  byDayError,
  formatByDay,
  isWeekdays,
  isWeekend,
  monthlyOrdinalOf,
  sameByDay,
  sortByDay,
  weekdayOf,
} from './byDay.ts';

describe('weekdayOf', () => {
  it('maps a date to its weekday code', () => {
    expect(weekdayOf('2026-09-20')).toBe('SU');
    expect(weekdayOf('2026-09-21')).toBe('MO');
    expect(weekdayOf('2026-09-26')).toBe('SA');
  });
});

describe('monthlyOrdinalOf', () => {
  it.each([
    ['2026-09-01', 1],
    ['2026-09-07', 1],
    ['2026-09-08', 2],
    ['2026-09-14', 2],
    ['2026-09-22', 4],
    ['2026-09-23', 4],
    // The last seven days of September (24–30) are "the last such weekday".
    ['2026-09-24', -1],
    ['2026-09-30', -1],
    ['2026-10-25', -1],
    ['2026-10-24', 4],
  ])('%s is the %s weekday of its month', (date, ordinal) => {
    expect(monthlyOrdinalOf(date)).toBe(ordinal);
  });
});

describe('sortByDay / formatByDay / sameByDay', () => {
  it('orders Monday first, then by ordinal, without mutating', () => {
    const days = [
      { weekday: 'SU' as const },
      { ordinal: 2, weekday: 'MO' as const },
      { weekday: 'MO' as const },
    ];
    expect(formatByDay(sortByDay(days))).toBe('MO,2MO,SU');
    expect(days[0]?.weekday).toBe('SU');
  });

  it('compares order-insensitively and treats absent as empty', () => {
    expect(
      sameByDay([{ weekday: 'SA' }, { weekday: 'SU' }], [{ weekday: 'SU' }, { weekday: 'SA' }]),
    ).toBe(true);
    expect(sameByDay(undefined, [])).toBe(true);
    expect(sameByDay([{ weekday: 'SA' }], [{ ordinal: 1, weekday: 'SA' }])).toBe(false);
  });
});

describe('isWeekend / isWeekdays', () => {
  it('recognises the two named sets exactly', () => {
    expect(isWeekend(['SA', 'SU'])).toBe(true);
    expect(isWeekend(['SA'])).toBe(false);
    expect(isWeekdays(['MO', 'TU', 'WE', 'TH', 'FR'])).toBe(true);
    expect(isWeekdays(['MO', 'TU', 'WE', 'TH', 'SA'])).toBe(false);
  });
});

describe('byDayError', () => {
  it('accepts plain weekdays on weekly rules and one ordinal weekday on monthly rules', () => {
    expect(byDayError({ freq: 'weekly' })).toBeUndefined();
    expect(
      byDayError({ byDay: [{ weekday: 'SA' }, { weekday: 'SU' }], freq: 'weekly' }),
    ).toBeUndefined();
    expect(byDayError({ byDay: [{ ordinal: 2, weekday: 'TU' }], freq: 'monthly' })).toBeUndefined();
    expect(
      byDayError({ byDay: [{ ordinal: -1, weekday: 'FR' }], freq: 'monthly' }),
    ).toBeUndefined();
    expect(byDayError({ byDay: [], freq: 'daily' })).toBeUndefined();
  });

  it('refuses ordinals on weekly rules, several or unordinal monthly entries, and by-day elsewhere', () => {
    expect(byDayError({ byDay: [{ ordinal: 1, weekday: 'MO' }], freq: 'weekly' })).toMatch(
      /ordinal/,
    );
    expect(
      byDayError({
        byDay: [
          { ordinal: 1, weekday: 'MO' },
          { ordinal: 2, weekday: 'TU' },
        ],
        freq: 'monthly',
      }),
    ).toMatch(/one weekday/);
    expect(byDayError({ byDay: [{ weekday: 'MO' }], freq: 'monthly' })).toMatch(/ordinal/);
    expect(byDayError({ byDay: [{ ordinal: 5, weekday: 'MO' }], freq: 'monthly' })).toMatch(
      /ordinal/,
    );
    expect(byDayError({ byDay: [{ weekday: 'MO' }], freq: 'daily' })).toMatch(/weekly and monthly/);
    expect(byDayError({ byDay: [{ ordinal: 2, weekday: 'SU' }], freq: 'yearly' })).toMatch(
      /weekly and monthly/,
    );
  });
});
