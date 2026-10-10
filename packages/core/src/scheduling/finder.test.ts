import { describe, expect, it } from 'vite-plus/test';
import {
  defaultFinderConstraints,
  finderBoundsOf,
  finderDaysOf,
  finderWindowDates,
  finderWindowOf,
  minutesBetween,
  withFinderBounds,
  withFinderDays,
  withFinderWindow,
} from './finder.ts';

// A Wednesday, a Sunday and a Monday: the week presets hinge on the weekday.
const WEDNESDAY = '2026-10-07';
const SUNDAY = '2026-10-11';
const MONDAY = '2026-10-12';

describe('finderWindowDates', () => {
  it('runs this week to the coming Sunday, next week Monday to Sunday after it', () => {
    expect(finderWindowDates('week', WEDNESDAY)).toEqual({
      windowEndDate: '2026-10-11',
      windowStartDate: WEDNESDAY,
    });
    expect(finderWindowDates('nextWeek', WEDNESDAY)).toEqual({
      windowEndDate: '2026-10-18',
      windowStartDate: '2026-10-12',
    });
  });

  it('is today alone for this week on a Sunday, and next week starts tomorrow', () => {
    expect(finderWindowDates('week', SUNDAY)).toEqual({
      windowEndDate: SUNDAY,
      windowStartDate: SUNDAY,
    });
    expect(finderWindowDates('nextWeek', SUNDAY)).toEqual({
      windowEndDate: '2026-10-18',
      windowStartDate: '2026-10-12',
    });
    expect(finderWindowDates('week', MONDAY)).toEqual({
      windowEndDate: '2026-10-18',
      windowStartDate: MONDAY,
    });
  });

  it('has today and two weeks as fixed spans', () => {
    expect(finderWindowDates('today', WEDNESDAY)).toEqual({
      windowEndDate: WEDNESDAY,
      windowStartDate: WEDNESDAY,
    });
    expect(finderWindowDates('fortnight', WEDNESDAY)).toEqual({
      windowEndDate: '2026-10-20',
      windowStartDate: WEDNESDAY,
    });
  });
});

describe('finder constraints', () => {
  it('starts with this week, any day and time, and the form duration', () => {
    const constraints = defaultFinderConstraints(45, WEDNESDAY);
    expect(constraints).toEqual({
      durationMinutes: 45,
      windowEndDate: '2026-10-11',
      windowStartDate: WEDNESDAY,
    });
    expect(finderWindowOf(constraints, WEDNESDAY)).toBe('week');
    expect(finderBoundsOf(constraints)).toBe('any');
    expect(finderDaysOf(constraints)).toBe('any');
    expect(defaultFinderConstraints(0, WEDNESDAY).durationMinutes).toBe(60);
  });

  it('sets and reads back the presets', () => {
    let constraints = defaultFinderConstraints(60, WEDNESDAY);
    constraints = withFinderWindow(constraints, 'nextWeek', WEDNESDAY);
    constraints = withFinderBounds(constraints, 'mornings');
    constraints = withFinderDays(constraints, 'weekdays');
    expect(constraints).toEqual({
      daysOfWeek: [1, 2, 3, 4, 5],
      durationMinutes: 60,
      earliestTime: '08:00',
      latestTime: '12:00',
      windowEndDate: '2026-10-18',
      windowStartDate: '2026-10-12',
    });
    expect(finderWindowOf(constraints, WEDNESDAY)).toBe('nextWeek');
    expect(finderBoundsOf(constraints)).toBe('mornings');
    expect(finderDaysOf(constraints)).toBe('weekdays');
    // Back to any: the fields go, they are not left at a preset's values.
    expect(withFinderBounds(withFinderDays(constraints, 'any'), 'any')).toEqual({
      durationMinutes: 60,
      windowEndDate: '2026-10-18',
      windowStartDate: '2026-10-12',
    });
  });

  it('reads no preset for dates, hours or days a phrase named freely', () => {
    const custom = {
      daysOfWeek: [2],
      durationMinutes: 30,
      earliestTime: '09:30',
      latestTime: '11:00',
      windowEndDate: '2026-10-13',
      windowStartDate: '2026-10-13',
    };
    expect(finderWindowOf(custom, WEDNESDAY)).toBeUndefined();
    expect(finderBoundsOf(custom)).toBeUndefined();
    expect(finderDaysOf(custom)).toBeUndefined();
  });
});

describe('minutesBetween', () => {
  it('measures a same-day span and never goes negative', () => {
    expect(minutesBetween('09:00', '10:30')).toBe(90);
    expect(minutesBetween('23:00', '23:59')).toBe(59);
    expect(minutesBetween('10:00', '09:00')).toBe(0);
  });
});
