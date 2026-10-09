import { Temporal } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { AGENDA_DAYS, titleFor, viewColumns } from './calendarNavigation.ts';

// Pure helpers over explicit dates: nothing here derives from "now".
const MONDAY = Temporal.PlainDate.from('2026-09-28');
const WEDNESDAY = Temporal.PlainDate.from('2026-09-30');

describe('viewColumns', () => {
  it('draws one, two or seven timeline columns and none for the month grid or the agenda', () => {
    expect(viewColumns('day')).toBe(1);
    expect(viewColumns('twoDay')).toBe(2);
    expect(viewColumns('week')).toBe(7);
    expect(viewColumns('month')).toBe(0);
    expect(viewColumns('agenda')).toBe(0);
  });
});

describe('titleFor', () => {
  it('spans the agenda from the focused day over its two weeks', () => {
    expect(AGENDA_DAYS).toBe(14);
    expect(titleFor('agenda', MONDAY, MONDAY, 'compact')).toBe('Sep 28 – Oct 11, 2026');
    expect(titleFor('agenda', WEDNESDAY, WEDNESDAY, 'long')).toBe('Sep 30 – Oct 13, 2026');
  });

  it('spans the two days of the two-day view', () => {
    expect(titleFor('twoDay', MONDAY, MONDAY, 'compact')).toBe('Sep 28 – 29, 2026');
    expect(titleFor('twoDay', MONDAY, MONDAY, 'long')).toBe('September 28 – 29, 2026');
  });

  it('names both months when the two days straddle one', () => {
    expect(titleFor('twoDay', WEDNESDAY, WEDNESDAY, 'compact')).toBe('Sep 30 – Oct 1, 2026');
  });

  it('keeps the week title on the seven-day window', () => {
    expect(titleFor('week', WEDNESDAY, MONDAY, 'compact')).toBe('Sep 28 – Oct 4, 2026');
    expect(titleFor('week', MONDAY, MONDAY, 'long')).toBe('Sep 28 – Oct 4, 2026');
  });

  it('names the focused day alone in the day view', () => {
    expect(titleFor('day', WEDNESDAY, WEDNESDAY, 'compact')).toBe('Wed, September 30');
  });
});
