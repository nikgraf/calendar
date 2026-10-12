import { GeoLocation, plainDateToUtcMs, Temporal, toZonedDateTime } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  candidatePreviews,
  draftOccurrences,
  draftPreview,
  eventDraftFromPrefill,
  prefillError,
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

  it('draws nothing for a draft whose date or time is mid-edit, rather than throwing', () => {
    // Review: a cleared date field reached buildEventTimes and took the grid down.
    for (const broken of [
      { ...dinner, date: '' },
      { ...dinner, startTime: '' },
      { ...dinner, endTime: '1' },
    ]) {
      const preview = draftPreview(
        { id: 'd1', item: { kind: 'event', prefill: broken } },
        { color: '#3b82f6', focused: true, timeZone: TZ },
      );
      expect(draftOccurrences([preview!], range.start, range.end, TZ)).toEqual([]);
    }
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
    // What the form held beyond the fields goes with the draft; guests only where the calendar can invite.
    const extras = {
      attendees: [{ email: 'anna@example.com' }],
      description: ' bring slides ',
      reminders: undefined,
    };
    expect(
      eventDraftFromPrefill(dinner, {
        accountId: 'acc',
        calendarId: 'cal',
        canInvite: true,
        extras,
        timeZone: TZ,
      }),
    ).toMatchObject({ attendees: [{ email: 'anna@example.com' }], description: 'bring slides' });
    expect(
      eventDraftFromPrefill(dinner, { accountId: 'acc', calendarId: 'cal', extras, timeZone: TZ }),
    ).not.toHaveProperty('attendees');
    // Review: picked coordinates go with the draft, only while they match its text.
    const geo = new GeoLocation({ lat: 48.2, lng: 16.4, source: "Luigi's" });
    const placed = { ...dinner, location: "Luigi's" };
    expect(
      eventDraftFromPrefill(placed, {
        accountId: 'acc',
        calendarId: 'cal',
        extras: { ...extras, geo },
        timeZone: TZ,
      }),
    ).toMatchObject({ geo: { lat: 48.2, lng: 16.4, source: "Luigi's" } });
    expect(
      eventDraftFromPrefill(
        { ...placed, location: 'Elsewhere' },
        {
          accountId: 'acc',
          calendarId: 'cal',
          extras: { ...extras, geo },
          timeZone: TZ,
        },
      ),
    ).not.toHaveProperty('geo');
  });

  it('says why a draft cannot be written, as Save would', () => {
    // Review: "Add all" wrote drafts Save would have refused.
    const context = { calendarKey: 'acc:cal', timeZone: TZ };
    expect(prefillError(dinner, context)).toBeUndefined();
    expect(prefillError({ ...dinner, title: ' ' }, context)).toBe(
      'A title and calendar are required.',
    );
    expect(prefillError({ ...dinner, endTime: '18:00' }, context)).toBeTruthy();
    expect(
      prefillError({ ...dinner, recurrence: { freq: 'weekly', untilDate: '2026-08-01' } }, context),
    ).toBe('The repeat must end on or after its first day.');
  });
});

describe('candidatePreviews', () => {
  const slots = [
    { date: '2026-08-28', endTime: '10:30', startTime: '10:00' },
    { date: '2026-08-28', endTime: '11:30', startTime: '11:00' },
    { date: '2026-08-29', endTime: '09:30', startTime: '09:00' },
  ];
  const draft = {
    id: 'd1',
    item: { kind: 'event' as const, prefill: { ...dinner, endTime: '10:30', startTime: '10:00' } },
    slots,
  };

  it('offers every slot but the one the form sits in, titled as the form is', () => {
    const previews = candidatePreviews(
      draft,
      { ...draft.item.prefill, title: 'Focus' },
      { color: '#123456' },
    );
    expect(previews.map((preview) => preview.startTime)).toEqual(['11:00', '09:00']);
    expect(previews[0]).toMatchObject({
      candidate: slots[1],
      color: '#123456',
      date: '2026-08-28',
      focused: false,
      id: 'd1',
      isAllDay: false,
      title: 'Focus',
    });
  });

  it('offers them all once the form moved off every slot', () => {
    expect(candidatePreviews(draft, dinner, { color: '#123456' })).toHaveLength(3);
  });

  it('is nothing for a draft without slots', () => {
    expect(candidatePreviews({ id: 'd2', item: draft.item }, dinner, { color: '#123456' })).toEqual(
      [],
    );
  });

  it('draws as blocks keyed by slot, the slot carried for the click', () => {
    const previews = candidatePreviews(draft, draft.item.prefill, { color: '#123456' });
    const occurrences = draftOccurrences(
      previews,
      plainDateToUtcMs('2026-08-27'),
      plainDateToUtcMs('2026-08-30'),
      TZ,
    );
    expect(occurrences.map((occurrence) => occurrence.key)).toEqual([
      'd1:slot:2026-08-28T11:00',
      'd1:slot:2026-08-29T09:00',
    ]);
    expect(occurrences[0]).toMatchObject({ candidate: slots[1], draftId: 'd1', focused: false });
    expect(occurrences[0]?.startUtc).toBe(wallClock('2026-08-28', '11:00'));
  });
});
