import { describe, expect, it } from 'vite-plus/test';
import { Temporal } from './time/temporal.ts';
import {
  DEFAULT_VIEW_PREFERENCES,
  expandedAllDayRows,
  isShadedDay,
  MAX_ALL_DAY_ROWS,
  portableViewPreferences,
  shadedWeekdays,
  withPortableViewPreferences,
} from './viewPreferences.ts';

describe('shadedWeekdays', () => {
  it('shades Saturday and Sunday until the user picks other days', () => {
    expect([...shadedWeekdays(DEFAULT_VIEW_PREFERENCES)]).toEqual(['SA', 'SU']);
    expect([...shadedWeekdays({ ...DEFAULT_VIEW_PREFERENCES, weekendDays: ['FR', 'SA'] })]).toEqual(
      ['FR', 'SA'],
    );
  });

  it('shades nothing while shading is off, whatever the days', () => {
    expect(
      shadedWeekdays({ ...DEFAULT_VIEW_PREFERENCES, weekendDays: ['FR'], weekendShading: false })
        .size,
    ).toBe(0);
    expect(shadedWeekdays({ ...DEFAULT_VIEW_PREFERENCES, weekendDays: [] }).size).toBe(0);
  });
});

describe('isShadedDay', () => {
  it('reads the date by its weekday', () => {
    const shaded = shadedWeekdays({ ...DEFAULT_VIEW_PREFERENCES, weekendDays: ['FR', 'SU'] });
    // 2026-10-23 is a Friday; the 24th a Saturday, the 25th a Sunday.
    expect(isShadedDay(shaded, Temporal.PlainDate.from('2026-10-23'))).toBe(true);
    expect(isShadedDay(shaded, Temporal.PlainDate.from('2026-10-24'))).toBe(false);
    expect(isShadedDay(shaded, Temporal.PlainDate.from('2026-10-25'))).toBe(true);
  });
});

describe('portableViewPreferences', () => {
  it('fills in the defaults and leaves the device-local fields out', () => {
    expect(
      portableViewPreferences({
        allDayLaneCollapsed: true,
        lastView: 'month',
        sidebarCollapsed: true,
      }),
    ).toEqual({ allDayLaneCollapsed: true, weekendDays: ['SA', 'SU'], weekendShading: true });
  });

  it('writes the days Monday first, each once', () => {
    expect(
      portableViewPreferences({ allDayLaneCollapsed: false, weekendDays: ['SA', 'FR', 'SA'] })
        .weekendDays,
    ).toEqual(['FR', 'SA']);
  });
});

describe('withPortableViewPreferences', () => {
  it('takes only the fields the file holds and keeps the device-local ones', () => {
    expect(
      withPortableViewPreferences(
        { allDayLaneCollapsed: true, lastView: 'week', weekendShading: false },
        { weekendDays: ['SU', 'SA'] },
      ),
    ).toEqual({
      allDayLaneCollapsed: true,
      lastView: 'week',
      weekendDays: ['SA', 'SU'],
      weekendShading: false,
    });
  });
});

describe('expandedAllDayRows', () => {
  it('takes whole rows from a third of the view', () => {
    // 800 / 3 = 266.7 px of 24 px rows.
    expect(expandedAllDayRows(800, 24)).toBe(11);
    expect(expandedAllDayRows(600, 24)).toBe(8);
  });

  it('never shows fewer rows than the collapsed lane', () => {
    expect(expandedAllDayRows(120, 24)).toBe(MAX_ALL_DAY_ROWS);
    expect(expandedAllDayRows(0, 24)).toBe(MAX_ALL_DAY_ROWS);
  });
});
