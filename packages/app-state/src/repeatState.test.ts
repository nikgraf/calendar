import { describe, expect, it } from 'vitest';
import {
  parseRepeatNumber,
  repeatDisplaySpec,
  repeatNumberError,
  repeatSpecFrom,
  seedRepeatFields,
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
  it('starts an unseeded form off, on the anchor weekday and ordinal', () => {
    expect(seedRepeatFields(undefined, SUNDAY)).toMatchObject({
      explicitWeekdays: false,
      monthly: 'dayOfMonth',
      ordinal: 3,
      ordinalWeekday: 'SU',
      repeat: 'none',
      weekdays: ['SU'],
    });
    expect(seedRepeatFields(undefined, TUESDAY)).toMatchObject({
      ordinal: 2,
      ordinalWeekday: 'TU',
    });
  });

  it('reads a weekly rule with named weekdays as explicit, Monday first', () => {
    expect(
      seedRepeatFields(
        { byDay: [{ weekday: 'SU' }, { weekday: 'SA' }], freq: 'weekly', interval: 1 },
        TUESDAY,
      ),
    ).toMatchObject({ explicitWeekdays: true, repeat: 'weekly', weekdays: ['SA', 'SU'] });
    expect(seedRepeatFields({ freq: 'weekly', interval: 2 }, TUESDAY)).toMatchObject({
      explicitWeekdays: false,
      interval: '2',
      weekdays: ['TU'],
    });
  });

  it('reads a monthly ordinal rule into weekday mode', () => {
    expect(
      seedRepeatFields(
        { byDay: [{ ordinal: -1, weekday: 'FR' }], freq: 'monthly', interval: 1 },
        SUNDAY,
      ),
    ).toMatchObject({ monthly: 'weekday', ordinal: -1, ordinalWeekday: 'FR', repeat: 'monthly' });
    expect(seedRepeatFields({ count: 6, freq: 'monthly', interval: 1 }, SUNDAY)).toMatchObject({
      count: '6',
      ends: 'after',
      monthly: 'dayOfMonth',
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
    expect(repeatSpecFrom(seedRepeatFields(undefined, SUNDAY), SUNDAY)).toBeUndefined();
  });

  it('keeps a weekly rule on the anchor weekday scalar, unless the seed named it', () => {
    const fresh = { ...seedRepeatFields(undefined, SUNDAY), repeat: 'weekly' as const };
    expect(repeatSpecFrom(fresh, SUNDAY)).toEqual({ freq: 'weekly', interval: 1 });
    const explicit = seedRepeatFields(
      { byDay: [{ weekday: 'SU' }], freq: 'weekly', interval: 1 },
      SUNDAY,
    );
    expect(repeatSpecFrom(explicit, SUNDAY)).toEqual({
      byDay: [{ weekday: 'SU' }],
      freq: 'weekly',
      interval: 1,
    });
  });

  it('names the weekdays once they differ from the anchor', () => {
    const fields = { ...seedRepeatFields(undefined, SUNDAY), repeat: 'weekly' as const };
    expect(
      repeatSpecFrom({ ...fields, weekdays: toggleWeekdayIn(fields.weekdays, 'SA') }, SUNDAY),
    ).toEqual({
      byDay: [{ weekday: 'SA' }, { weekday: 'SU' }],
      freq: 'weekly',
      interval: 1,
    });
  });

  it('names the ordinal weekday only in monthly weekday mode', () => {
    const base = { ...seedRepeatFields(undefined, TUESDAY), repeat: 'monthly' as const };
    expect(repeatSpecFrom(base, TUESDAY)).toEqual({ freq: 'monthly', interval: 1 });
    expect(repeatSpecFrom({ ...base, monthly: 'weekday' }, TUESDAY)).toEqual({
      byDay: [{ ordinal: 2, weekday: 'TU' }],
      freq: 'monthly',
      interval: 1,
    });
  });

  it('carries the end condition and the display spec always shows weekdays', () => {
    const fields = {
      ...seedRepeatFields(undefined, SUNDAY),
      count: '5',
      ends: 'after' as const,
      repeat: 'weekly' as const,
    };
    expect(repeatSpecFrom(fields, SUNDAY)).toEqual({ count: 5, freq: 'weekly', interval: 1 });
    expect(repeatDisplaySpec(fields)).toEqual({
      byDay: [{ weekday: 'SU' }],
      count: 5,
      freq: 'weekly',
      interval: 1,
    });
  });
});
