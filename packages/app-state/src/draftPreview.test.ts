import { plainDateToUtcMs, Temporal, toZonedDateTime } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  draftOccurrences,
  draftPreview,
  eventDraftFromPrefill,
  prefillRecurrence,
} from './draftPreview.ts';

const TZ = 'Europe/Vienna';
const dinner = {
  date: '2026-08-28',
  endTime: '20:00',
  isAllDay: false,
  startTime: '19:00',
  title: 'Dinner with Teo',
};
const wallClock = (date: string, time: string) =>
  Temporal.PlainDate.from(date).toZonedDateTime({
    plainTime: Temporal.PlainTime.from(time),
    timeZone: TZ,
  }).epochMilliseconds;
// A fortnight around the draft, as the grid would ask.
const range = { end: plainDateToUtcMs('2026-09-11'), start: plainDateToUtcMs('2026-08-24') };

describe('draftPreview and draftOccurrences', () => {
  it('draws an event draft once, in its calendar color, and a to-do not at all', () => {
    const preview = draftPreview(
      { id: 'd1', item: { kind: 'event', prefill: dinner } },
      { color: '#3b82f6', focused: true, timeZone: TZ },
    );
    expect(preview).toMatchObject({
      color: '#3b82f6',
      focused: true,
      id: 'd1',
      title: 'Dinner with Teo',
    });
    expect(draftOccurrences([preview!], range.start, range.end, TZ)).toEqual([
      {
        color: '#3b82f6',
        draftId: 'd1',
        endTime: '20:00',
        endUtc: wallClock('2026-08-28', '20:00'),
        focused: true,
        isAllDay: false,
        key: 'd1',
        startTime: '19:00',
        startUtc: wallClock('2026-08-28', '19:00'),
        title: 'Dinner with Teo',
      },
    ]);
    expect(
      draftPreview(
        { id: 'd2', item: { kind: 'task', prefill: { date: '2026-08-28', title: 'Bank' } } },
        { color: '#000', focused: false, timeZone: TZ },
      ),
    ).toBeUndefined();
  });

  it('leaves out a draft outside the range', () => {
    const preview = draftPreview(
      { id: 'd1', item: { kind: 'event', prefill: { ...dinner, date: '2026-10-01' } } },
      { color: '#3b82f6', focused: false, timeZone: TZ },
    );
    expect(draftOccurrences([preview!], range.start, range.end, TZ)).toEqual([]);
  });

  it('draws every occurrence of a repeating draft in the range, with the dates of an all-day one', () => {
    const weekly = draftPreview(
      {
        id: 'd1',
        item: { kind: 'event', prefill: { ...dinner, recurrence: { freq: 'weekly' } } },
      },
      { color: '#3b82f6', focused: false, timeZone: TZ },
    )!;
    expect(weekly.recurrence).toEqual(['RRULE:FREQ=WEEKLY']);
    const occurrences = draftOccurrences([weekly], range.start, range.end, TZ);
    expect(occurrences.map((occurrence) => occurrence.key)).toEqual([
      `d1:${String(wallClock('2026-08-28', '19:00'))}`,
      `d1:${String(wallClock('2026-09-04', '19:00'))}`,
    ]);
    expect(
      occurrences.map((occurrence) =>
        toZonedDateTime(occurrence.startUtc, TZ).toPlainDate().toString(),
      ),
    ).toEqual(['2026-08-28', '2026-09-04']);

    const allDay = draftPreview(
      {
        id: 'd2',
        item: {
          kind: 'event',
          prefill: { ...dinner, isAllDay: true, recurrence: { count: 2, freq: 'daily' } },
        },
      },
      { color: '#3b82f6', focused: false, timeZone: TZ },
    )!;
    expect(draftOccurrences([allDay], range.start, range.end, TZ)).toMatchObject([
      { endDate: '2026-08-29', isAllDay: true, startDate: '2026-08-28' },
      { endDate: '2026-08-30', isAllDay: true, startDate: '2026-08-29' },
    ]);
  });
});

describe('eventDraftFromPrefill', () => {
  it('builds the create the way Save would, with the rule the repeat fields give', () => {
    expect(
      eventDraftFromPrefill(
        { ...dinner, location: "Luigi's", recurrence: { count: 3, freq: 'weekly' } },
        { accountId: 'acc', calendarId: 'cal', timeZone: TZ },
      ),
    ).toEqual({
      accountId: 'acc',
      calendarId: 'cal',
      endUtc: wallClock('2026-08-28', '20:00'),
      isAllDay: false,
      location: "Luigi's",
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'],
      startTimeZone: TZ,
      startUtc: wallClock('2026-08-28', '19:00'),
      title: 'Dinner with Teo',
    });
    expect(prefillRecurrence(dinner, TZ)).toBeUndefined();
    expect(
      eventDraftFromPrefill(
        { ...dinner, isAllDay: true },
        { accountId: 'acc', calendarId: 'cal', timeZone: TZ },
      ),
    ).toMatchObject({ endDate: '2026-08-29', isAllDay: true, startDate: '2026-08-28' });
  });
});
