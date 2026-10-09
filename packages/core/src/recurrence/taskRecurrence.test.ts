import { describe, expect, it } from 'vite-plus/test';
import { taskRecurrenceFromLines } from './taskRecurrence.ts';

describe('taskRecurrenceFromLines', () => {
  it('reads the subset a reminder can hold', () => {
    expect(taskRecurrenceFromLines(['RRULE:FREQ=WEEKLY;BYDAY=SA,SU'], { isAllDay: false })).toEqual(
      { byDay: [{ weekday: 'SA' }, { weekday: 'SU' }], freq: 'weekly', interval: 1 },
    );
    expect(
      taskRecurrenceFromLines(['RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU;COUNT=5'], {
        isAllDay: true,
      }),
    ).toEqual({ byDay: [{ ordinal: 2, weekday: 'TU' }], count: 5, freq: 'monthly', interval: 2 });
    expect(
      taskRecurrenceFromLines(['RRULE:FREQ=DAILY;UNTIL=20260930'], { isAllDay: true }),
    ).toEqual({ freq: 'daily', interval: 1, untilDate: '2026-09-30' });
  });

  it('places a timed UNTIL on the last day an occurrence still starts before it', () => {
    const lines = ['RRULE:FREQ=DAILY;UNTIL=20260930T235959Z'];
    // 2026-10-01 01:59:59 in Berlin: that day's 09:00 is past the instant.
    expect(
      taskRecurrenceFromLines(lines, {
        isAllDay: false,
        startTime: '09:00',
        timeZone: 'Europe/Berlin',
      })?.untilDate,
    ).toBe('2026-09-30');
    expect(
      taskRecurrenceFromLines(lines, {
        isAllDay: false,
        startTime: '09:00',
        timeZone: 'America/Los_Angeles',
      })?.untilDate,
    ).toBe('2026-09-30');
    // A midnight occurrence east of UTC on the instant's own day still fits.
    expect(
      taskRecurrenceFromLines(lines, {
        isAllDay: false,
        startTime: '01:00',
        timeZone: 'Europe/Berlin',
      })?.untilDate,
    ).toBe('2026-10-01');
  });

  it('refuses what a reminder cannot say', () => {
    for (const lines of [
      ['RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15'],
      ['RRULE:FREQ=YEARLY;BYDAY=2TU'],
      ['RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9'],
      ['RRULE:FREQ=DAILY', 'EXDATE:20260930T090000Z'],
      ['RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY'],
      ['RRULE:FREQ=MONTHLY;BYDAY=5TU'],
    ]) {
      expect(taskRecurrenceFromLines(lines, { isAllDay: false })).toBeUndefined();
    }
    expect(taskRecurrenceFromLines(undefined, { isAllDay: false })).toBeUndefined();
    expect(taskRecurrenceFromLines([], { isAllDay: false })).toBeUndefined();
  });
});
