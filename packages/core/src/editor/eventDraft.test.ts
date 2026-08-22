import { describe, expect, it } from 'vitest';
import { buildEventTimes, validateEventDraft } from './eventDraft.ts';

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
