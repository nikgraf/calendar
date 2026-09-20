import { describe, expect, it } from 'vitest';
import { recurrenceLabel } from './label.ts';

describe('recurrenceLabel', () => {
  it('names the frequency and interval', () => {
    expect(recurrenceLabel({ freq: 'daily' })).toBe('Daily');
    expect(recurrenceLabel({ freq: 'daily', interval: 3 })).toBe('Every 3 days');
    expect(recurrenceLabel({ freq: 'weekly', interval: 1 })).toBe('Weekly');
    expect(recurrenceLabel({ freq: 'yearly' })).toBe('Yearly');
  });

  it('names weekly weekdays, with the weekend and weekday sets by name', () => {
    expect(recurrenceLabel({ byDay: [{ weekday: 'SU' }, { weekday: 'SA' }], freq: 'weekly' })).toBe(
      'Weekly on weekends',
    );
    expect(
      recurrenceLabel({
        byDay: ['MO', 'TU', 'WE', 'TH', 'FR'].map((weekday) => ({ weekday: weekday as 'MO' })),
        freq: 'weekly',
        interval: 2,
      }),
    ).toBe('Every 2 weeks on weekdays');
    expect(recurrenceLabel({ byDay: [{ weekday: 'WE' }, { weekday: 'MO' }], freq: 'weekly' })).toBe(
      'Weekly on Monday, Wednesday',
    );
  });

  it('names the monthly ordinal weekday', () => {
    expect(recurrenceLabel({ byDay: [{ ordinal: 2, weekday: 'TU' }], freq: 'monthly' })).toBe(
      'Monthly on the 2nd Tuesday',
    );
    expect(
      recurrenceLabel({ byDay: [{ ordinal: -1, weekday: 'FR' }], freq: 'monthly', interval: 3 }),
    ).toBe('Every 3 months on the last Friday');
  });

  it('appends the end condition', () => {
    expect(recurrenceLabel({ count: 10, freq: 'daily' })).toBe('Daily, 10 times');
    expect(recurrenceLabel({ count: 1, freq: 'daily' })).toBe('Daily, 1 time');
    expect(recurrenceLabel({ freq: 'weekly', untilDate: '2026-09-30' })).toBe(
      'Weekly, until Sep 30, 2026',
    );
  });
});
