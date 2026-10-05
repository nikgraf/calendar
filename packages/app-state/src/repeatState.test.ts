import { describe, expect, it } from 'vitest';
import {
  parseRepeatNumber,
  repeatDisplaySpec,
  repeatNumberError,
  repeatSpecFrom,
  seedRepeatFields,
  shownOrdinal,
  shownWeekdays,
  toggleWeekdayIn,
} from './repeatState.ts';

describe('parseRepeatNumber', () => {
  it('reads a small positive integer as is', () => {
    expect(parseRepeatNumber('3')).toBe(3);
    expect(parseRepeatNumber(' 12 ')).toBe(12);
  });

  it('never yields something a trapping native cast could choke on', () => {
    // 1e20 parses as 1 (parseInt stops at "e"); huge digits clamp.
    expect(parseRepeatNumber('1e20')).toBe(1);
    expect(parseRepeatNumber('99999999999999999999')).toBe(999);
    expect(parseRepeatNumber('Infinity')).toBe(1);
    expect(parseRepeatNumber('NaN')).toBe(1);
    expect(parseRepeatNumber('')).toBe(1);
    expect(parseRepeatNumber('0')).toBe(1);
    expect(parseRepeatNumber('-4')).toBe(1);
    expect(parseRepeatNumber('3.5')).toBe(3);
  });
});

describe('repeatNumberError', () => {
  it('accepts whole numbers 1…999', () => {
    expect(repeatNumberError('1', 'The repeat interval')).toBeUndefined();
    expect(repeatNumberError('999', 'The repeat interval')).toBeUndefined();
  });

  it('refuses what the form should not send', () => {
    for (const text of ['', '0', '1000', '3.5', '1e20', '-1', 'two']) {
      expect(repeatNumberError(text, 'The repeat interval')).toBe(
        'The repeat interval must be a whole number between 1 and 999.',
      );
    }
  });
});

// 2026-09-20 is the third Sunday of September.
const SUNDAY = '2026-09-20';
// 2026-09-08 is the second Tuesday of September.
const TUESDAY = '2026-09-08';

describe('seedRepeatFields', () => {
  it('starts an unseeded form off, following the anchor for weekdays and ordinal', () => {
    const fields = seedRepeatFields(undefined);
    expect(fields).toMatchObject({
      monthly: 'dayOfMonth',
      ordinalExplicit: false,
      repeat: 'none',
      weekdays: [],
      weekdaysExplicit: false,
    });
    expect(shownWeekdays(fields, SUNDAY)).toEqual(['SU']);
    expect(shownOrdinal(fields, SUNDAY)).toEqual({ ordinal: 3, weekday: 'SU' });
    expect(shownOrdinal(fields, TUESDAY)).toEqual({ ordinal: 2, weekday: 'TU' });
  });

  it('survives a date field mid-edit', () => {
    const fields = seedRepeatFields(undefined);
    expect(shownWeekdays(fields, '')).toEqual(['MO']);
    expect(shownOrdinal(fields, '2026-0')).toEqual({ ordinal: 1, weekday: 'MO' });
    expect(repeatSpecFrom({ ...fields, repeat: 'weekly' }, '')).toEqual({
      freq: 'weekly',
      interval: 1,
    });
  });

  it('reads a weekly rule with named weekdays as explicit, Monday first', () => {
    expect(
      seedRepeatFields({
        byDay: [{ weekday: 'SU' }, { weekday: 'SA' }],
        freq: 'weekly',
        interval: 1,
      }),
    ).toMatchObject({ repeat: 'weekly', weekdays: ['SA', 'SU'], weekdaysExplicit: true });
    const scalar = seedRepeatFields({ freq: 'weekly', interval: 2 });
    expect(scalar).toMatchObject({ interval: '2', weekdays: [], weekdaysExplicit: false });
    expect(shownWeekdays(scalar, TUESDAY)).toEqual(['TU']);
  });

  it('reads a monthly ordinal rule into weekday mode', () => {
    expect(
      seedRepeatFields({ byDay: [{ ordinal: -1, weekday: 'FR' }], freq: 'monthly', interval: 1 }),
    ).toMatchObject({
      monthly: 'weekday',
      ordinal: -1,
      ordinalExplicit: true,
      ordinalWeekday: 'FR',
    });
    expect(seedRepeatFields({ count: 6, freq: 'monthly', interval: 1 })).toMatchObject({
      count: '6',
      ends: 'after',
      monthly: 'dayOfMonth',
      ordinalExplicit: false,
    });
  });
});

describe('toggleWeekdayIn', () => {
  it('adds in Monday-first order and never removes the last day', () => {
    expect(toggleWeekdayIn(['SU'], 'MO')).toEqual(['MO', 'SU']);
    expect(toggleWeekdayIn(['MO', 'SU'], 'SU')).toEqual(['MO']);
    expect(toggleWeekdayIn(['MO'], 'MO')).toEqual(['MO']);
  });
});

describe('repeatSpecFrom', () => {
  it('is undefined while repeat is off', () => {
    expect(repeatSpecFrom(seedRepeatFields(undefined), SUNDAY)).toBeUndefined();
  });

  it('keeps an untouched weekly rule scalar, whatever date it moves to', () => {
    const fresh = { ...seedRepeatFields(undefined), repeat: 'weekly' as const };
    expect(repeatSpecFrom(fresh, SUNDAY)).toEqual({ freq: 'weekly', interval: 1 });
    expect(repeatSpecFrom(fresh, TUESDAY)).toEqual({ freq: 'weekly', interval: 1 });
  });

  it('sends a seeded explicit rule back with its weekdays', () => {
    const explicit = seedRepeatFields({ byDay: [{ weekday: 'SU' }], freq: 'weekly', interval: 1 });
    expect(repeatSpecFrom(explicit, SUNDAY)).toEqual({
      byDay: [{ weekday: 'SU' }],
      freq: 'weekly',
      interval: 1,
    });
  });

  it('names the weekdays once the user toggled one', () => {
    const fields = { ...seedRepeatFields(undefined), repeat: 'weekly' as const };
    const toggled = {
      ...fields,
      weekdays: toggleWeekdayIn(shownWeekdays(fields, SUNDAY), 'SA'),
      weekdaysExplicit: true,
    };
    expect(repeatSpecFrom(toggled, SUNDAY)).toEqual({
      byDay: [{ weekday: 'SA' }, { weekday: 'SU' }],
      freq: 'weekly',
      interval: 1,
    });
  });

  it('names the ordinal weekday only in monthly weekday mode, following the date until picked', () => {
    const base = { ...seedRepeatFields(undefined), repeat: 'monthly' as const };
    expect(repeatSpecFrom(base, TUESDAY)).toEqual({ freq: 'monthly', interval: 1 });
    const weekdayMode = { ...base, monthly: 'weekday' as const };
    expect(repeatSpecFrom(weekdayMode, TUESDAY)).toEqual({
      byDay: [{ ordinal: 2, weekday: 'TU' }],
      freq: 'monthly',
      interval: 1,
    });
    expect(repeatSpecFrom(weekdayMode, SUNDAY)?.byDay).toEqual([{ ordinal: 3, weekday: 'SU' }]);
    const picked = {
      ...weekdayMode,
      ordinal: -1 as const,
      ordinalExplicit: true,
      ordinalWeekday: 'FR' as const,
    };
    expect(repeatSpecFrom(picked, SUNDAY)?.byDay).toEqual([{ ordinal: -1, weekday: 'FR' }]);
  });

  it('carries the end condition, and the display spec always shows weekdays', () => {
    const fields = {
      ...seedRepeatFields(undefined),
      count: '5',
      ends: 'after' as const,
      repeat: 'weekly' as const,
    };
    expect(repeatSpecFrom(fields, SUNDAY)).toEqual({ count: 5, freq: 'weekly', interval: 1 });
    expect(repeatDisplaySpec(fields, SUNDAY)).toEqual({
      byDay: [{ weekday: 'SU' }],
      count: 5,
      freq: 'weekly',
      interval: 1,
    });
  });
});
