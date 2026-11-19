import { buildEventTimes, type EventDraft, Temporal } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { createdItemDay, type CreatedItem } from './createdItem.ts';

const event = (
  date: string,
  recurrence?: ReadonlyArray<string>,
  isAllDay = false,
  timeZone = 'Europe/Vienna',
): CreatedItem => ({
  event: {
    accountId: 'account',
    calendarId: 'calendar',
    isAllDay,
    recurrence,
    title: 'Created event',
    ...buildEventTimes({ date, endTime: '10:00', isAllDay, startTime: '09:00' }, timeZone),
  } satisfies EventDraft,
  kind: 'event',
});

const destination = (
  item: CreatedItem,
  first = '2026-09-16',
  last = first,
  timeZone = 'Europe/Vienna',
) =>
  createdItemDay(
    item,
    Temporal.PlainDate.from(first),
    Temporal.PlainDate.from(last),
    timeZone,
  )?.toString();

describe('the calendar destination after creating an item', () => {
  it('shows the saved date of a single event, task or reminder', () => {
    expect(destination(event('2026-12-04'))).toBe('2026-12-04');
    expect(destination({ date: '2026-12-06', kind: 'task' })).toBe('2026-12-06');
  });

  it('leaves the view alone for an undated to-do', () => {
    expect(destination({ date: undefined, kind: 'task' })).toBeUndefined();
  });

  it('ignores an invalid typed task date instead of crashing after the write', () => {
    expect(destination({ date: '2027-02-30', kind: 'task' })).toBeUndefined();
    expect(destination({ date: '', kind: 'task' })).toBeUndefined();
  });

  it('prefers an occurrence in the visible view to the series start', () => {
    expect(
      destination(event('2026-01-05', ['RRULE:FREQ=WEEKLY']), '2026-09-16', '2026-09-22'),
    ).toBe('2026-09-21');
  });

  it('picks the nearer occurrence before or after a day view, preferring later on ties', () => {
    const weekly = event('2026-01-05', ['RRULE:FREQ=WEEKLY']);
    expect(destination(weekly, '2026-09-16')).toBe('2026-09-14');
    expect(destination(weekly, '2026-09-18')).toBe('2026-09-21');
    expect(destination(weekly, '2026-09-17', '2026-09-18')).toBe('2026-09-21');
  });

  it('uses the visible range edges, not a buffered fetch range or the focused day', () => {
    const monthly = event('2026-01-01', ['RRULE:FREQ=MONTHLY']);
    expect(destination(monthly, '2026-09-17', '2026-09-23')).toBe('2026-10-01');
    expect(destination(monthly, '2026-09-01', '2026-09-30')).toBe('2026-09-01');
  });

  it('handles series that have not started and series ended by COUNT or UNTIL', () => {
    expect(destination(event('2027-01-04', ['RRULE:FREQ=WEEKLY']))).toBe('2027-01-04');
    expect(destination(event('2026-01-05', ['RRULE:FREQ=WEEKLY;COUNT=3']))).toBe('2026-01-19');
    expect(destination(event('2026-01-05', ['RRULE:FREQ=WEEKLY;UNTIL=20260131T235959Z']))).toBe(
      '2026-01-26',
    );
  });

  it('honors exclusions and explicit occurrence dates', () => {
    expect(
      destination(
        event('2026-01-05', ['RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/Vienna:20260914T090000']),
      ),
    ).toBe('2026-09-21');
    expect(destination(event('2026-01-05', ['RDATE;TZID=Europe/Vienna:20260915T090000']))).toBe(
      '2026-09-15',
    );
  });

  it('keeps all-day dates floating and uses the display zone for timed events', () => {
    const allDay = event('2026-09-16', undefined, true);
    expect(destination(allDay, '2026-09-16', '2026-09-16', 'America/Los_Angeles')).toBe(
      '2026-09-16',
    );
    const timed = event('2026-09-16', ['RRULE:FREQ=WEEKLY'], false, 'Asia/Tokyo');
    expect(destination(timed, '2026-09-22', '2026-09-22', 'America/Los_Angeles')).toBe(
      '2026-09-22',
    );
    expect(destination(event('2026-01-05', ['RRULE:FREQ=WEEKLY'], true), '2026-09-16')).toBe(
      '2026-09-14',
    );
  });

  it('keeps a weekly occurrence on its local day across DST', () => {
    expect(destination(event('2026-03-01', ['RRULE:FREQ=WEEKLY']), '2026-03-29')).toBe(
      '2026-03-29',
    );
  });

  it('falls back to the start date if a saved rule cannot be evaluated', () => {
    expect(destination(event('2026-01-05', ['RRULE:FREQ=INVALID']))).toBe('2026-01-05');
  });
});
