import { describe, expect, it } from 'vite-plus/test';
import {
  buildEventTimes,
  draftMinutes,
  editorDatesOf,
  timeFieldsChanged,
  validateEventDraft,
} from './eventDraft.ts';

const TZ = 'Europe/Vienna';
const timed = { date: '2026-08-22', endTime: '10:30', isAllDay: false, startTime: '09:00' };

describe('eventDraft', () => {
  it('builds timed events in the given zone and keeps the zone', () => {
    const times = buildEventTimes(timed, TZ);
    // 09:00 in Vienna (UTC+2 in August) is 07:00 UTC.
    expect(times.startUtc).toBe(Date.parse('2026-08-22T07:00:00Z'));
    expect(times.endUtc).toBe(Date.parse('2026-08-22T08:30:00Z'));
    expect(times.startTimeZone).toBe(TZ);
    expect(times.startDate).toBeUndefined();
  });

  it('builds all-day events as whole dates with an exclusive end', () => {
    const times = buildEventTimes({ ...timed, isAllDay: true }, TZ);
    expect(times.startDate).toBe('2026-08-22');
    expect(times.endDate).toBe('2026-08-23');
    expect(times.startUtc).toBe(Date.parse('2026-08-22T00:00:00Z'));
    expect(times.startTimeZone).toBeUndefined();
  });

  it('spans 23 hours across a spring DST transition', () => {
    // Vienna loses an hour on 2026-03-29.
    const times = buildEventTimes(
      { date: '2026-03-29', endTime: '23:59', isAllDay: false, startTime: '00:00' },
      TZ,
    );
    expect((times.endUtc - times.startUtc) / (60 * 60 * 1000)).toBeCloseTo(22.98, 1);
  });

  it('builds a multi-day all-day event from its last day', () => {
    const times = buildEventTimes({ ...timed, endDate: '2026-08-24', isAllDay: true }, TZ);
    expect(times.startDate).toBe('2026-08-22');
    expect(times.endDate).toBe('2026-08-25');
  });

  it('builds an overnight event on its end date', () => {
    const times = buildEventTimes(
      {
        date: '2026-08-22',
        endDate: '2026-08-23',
        endTime: '01:00',
        isAllDay: false,
        startTime: '23:00',
      },
      TZ,
    );
    expect(times.startUtc).toBe(Date.parse('2026-08-22T21:00:00Z'));
    expect(times.endUtc).toBe(Date.parse('2026-08-22T23:00:00Z'));
  });

  it('reads stored times back into the dates they were built from', () => {
    const allDay = buildEventTimes({ ...timed, endDate: '2026-08-24', isAllDay: true }, TZ);
    expect(editorDatesOf({ ...allDay, isAllDay: true }, TZ)).toEqual({
      date: '2026-08-22',
      endDate: '2026-08-24',
    });
    const overnight = buildEventTimes(
      {
        date: '2026-08-22',
        endDate: '2026-08-23',
        endTime: '01:00',
        isAllDay: false,
        startTime: '23:00',
      },
      TZ,
    );
    expect(editorDatesOf({ ...overnight, isAllDay: false }, TZ)).toEqual({
      date: '2026-08-22',
      endDate: '2026-08-23',
    });
    // The same instants are another day in another zone.
    expect(editorDatesOf({ ...overnight, isAllDay: false }, 'America/New_York')).toEqual({
      date: '2026-08-22',
      endDate: '2026-08-22',
    });
    // A malformed all-day end (not after the start) still reads as one day.
    expect(
      editorDatesOf(
        {
          endDate: '2026-08-22',
          endUtc: Date.parse('2026-08-22T00:00:00Z'),
          isAllDay: true,
          startDate: '2026-08-22',
          startUtc: Date.parse('2026-08-22T00:00:00Z'),
        },
        TZ,
      ),
    ).toEqual({ date: '2026-08-22', endDate: '2026-08-22' });
  });

  it('measures a draft from its start day to its end day', () => {
    expect(draftMinutes(timed, TZ)).toBe(90);
    expect(
      draftMinutes({ ...timed, endDate: '2026-08-23', endTime: '01:00', startTime: '23:00' }, TZ),
    ).toBe(120);
    // Mid-edit fields build nothing: no length rather than a throw.
    expect(draftMinutes({ ...timed, endDate: '' }, TZ)).toBe(0);
  });

  it('tells an untouched form from a changed one', () => {
    const opened = { ...timed, endDate: '2026-08-24', isAllDay: true };
    expect(timeFieldsChanged(opened, opened)).toBe(false);
    // An all-day event's hidden times do not count.
    expect(timeFieldsChanged({ ...opened, startTime: '11:00' }, opened)).toBe(false);
    expect(timeFieldsChanged({ ...opened, endDate: '2026-08-23' }, opened)).toBe(true);
    expect(timeFieldsChanged({ ...opened, date: '2026-08-21' }, opened)).toBe(true);
    expect(timeFieldsChanged({ ...opened, isAllDay: false }, opened)).toBe(true);
    expect(timeFieldsChanged({ ...timed, endTime: '11:00' }, timed)).toBe(true);
    // No end date reads as the start's.
    expect(timeFieldsChanged({ ...timed, endDate: '2026-08-22' }, timed)).toBe(false);
  });

  it('requires a title and a calendar', () => {
    expect(validateEventDraft({ ...timed, calendarKey: 'acc:cal', title: '  ' }, TZ)).toBe(
      'A title and calendar are required.',
    );
    expect(validateEventDraft({ ...timed, calendarKey: '', title: 'Standup' }, TZ)).toBe(
      'A title and calendar are required.',
    );
    // A calendar key must carry both halves.
    expect(validateEventDraft({ ...timed, calendarKey: 'acc', title: 'Standup' }, TZ)).toBe(
      'A title and calendar are required.',
    );
  });

  it('requires the end to be after the start for timed events only', () => {
    const backwards = { ...timed, calendarKey: 'acc:cal', endTime: '09:00', title: 'Standup' };
    expect(validateEventDraft(backwards, TZ)).toBe('End must be after start.');
    // All-day ignores the times entirely.
    expect(validateEventDraft({ ...backwards, isAllDay: true }, TZ)).toBeNull();
  });

  it('takes an end on a later day, and refuses an end date before the start', () => {
    const draft = { ...timed, calendarKey: 'acc:cal', title: 'Night shift' };
    expect(
      validateEventDraft(
        { ...draft, endDate: '2026-08-23', endTime: '01:00', startTime: '23:00' },
        TZ,
      ),
    ).toBeNull();
    expect(validateEventDraft({ ...draft, endDate: '2026-08-21' }, TZ)).toBe(
      'End must be after start.',
    );
    expect(validateEventDraft({ ...draft, endDate: '2026-08-24', isAllDay: true }, TZ)).toBeNull();
    expect(validateEventDraft({ ...draft, endDate: '2026-08-22', isAllDay: true }, TZ)).toBeNull();
    expect(validateEventDraft({ ...draft, endDate: '2026-08-21', isAllDay: true }, TZ)).toBe(
      'End must not be before start.',
    );
    // A cleared end date field is a missing date, not a crash.
    expect(validateEventDraft({ ...draft, endDate: '' }, TZ)).toBe('A date is required.');
  });

  it('reports unusable dates instead of throwing', () => {
    expect(validateEventDraft({ ...timed, calendarKey: 'acc:cal', date: '', title: 'x' }, TZ)).toBe(
      'A date is required.',
    );
    expect(
      validateEventDraft({ ...timed, calendarKey: 'acc:cal', date: '2026-13-45', title: 'x' }, TZ),
    ).toBe('That date or time is not valid.');
  });

  it('accepts a valid draft', () => {
    expect(
      validateEventDraft({ ...timed, calendarKey: 'acc:cal', title: 'Standup' }, TZ),
    ).toBeNull();
  });
});
