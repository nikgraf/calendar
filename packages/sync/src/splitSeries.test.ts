import { EventRecord } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { drawsFrom } from './splitSeries.ts';

const at = (iso: string) => Date.parse(iso);

/** Daily at 10:00 UTC from July 2, an hour long unless `overrides` says. */
const series = (overrides: Partial<EventRecord> = {}): EventRecord =>
  new EventRecord({
    accountId: 'acc-1',
    calendarId: 'cal-1',
    endUtc: at('2026-07-02T11:00:00Z'),
    etag: null,
    id: 'evt-r',
    isAllDay: false,
    recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
    startTimeZone: 'UTC',
    startUtc: at('2026-07-02T10:00:00Z'),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Daily',
    updatedAt: 0,
    ...overrides,
  });

describe('drawsFrom', () => {
  it('reads a COUNT rule up to its last occurrence', () => {
    expect(drawsFrom(series(), at('2026-07-06T10:00:00Z'))).toBe(true);
    expect(drawsFrom(series(), at('2026-07-06T10:00:01Z'))).toBe(false);
  });

  it('counts an occurrence with no duration at either end', () => {
    const instant = series({ endUtc: at('2026-07-02T10:00:00Z') });
    expect(drawsFrom(instant, at('2026-07-05T10:00:00Z'))).toBe(true);
    expect(drawsFrom(instant, at('2026-07-06T10:00:00Z'))).toBe(true);
    expect(drawsFrom(instant, at('2026-07-06T10:00:01Z'))).toBe(false);
  });

  it('ends a cut series just before the cut', () => {
    const cut = series({ recurrence: ['RRULE:FREQ=DAILY;UNTIL=20260703T095959Z'] });
    expect(drawsFrom(cut, at('2026-07-02T10:00:00Z'))).toBe(true);
    expect(drawsFrom(cut, at('2026-07-03T10:00:00Z'))).toBe(false);
  });

  it('reads an all-day UNTIL as its last day', () => {
    const allDay = series({
      endDate: '2026-07-03',
      endUtc: at('2026-07-03T00:00:00Z'),
      isAllDay: true,
      recurrence: ['RRULE:FREQ=DAILY;UNTIL=20260704'],
      startDate: '2026-07-02',
      startUtc: at('2026-07-02T00:00:00Z'),
    });
    expect(drawsFrom(allDay, at('2026-07-04T00:00:00Z'))).toBe(true);
    expect(drawsFrom(allDay, at('2026-07-05T00:00:00Z'))).toBe(false);
  });

  it('takes an endless rule to draw on', () => {
    expect(
      drawsFrom(series({ recurrence: ['RRULE:FREQ=WEEKLY'] }), at('2030-01-01T00:00:00Z')),
    ).toBe(true);
  });

  it('looks for an occurrence when the end of a long series cannot be told', () => {
    // Daily since 1990 with an RDATE: too long to enumerate for its end.
    const since1990 = (rule: string) =>
      series({
        endUtc: at('1990-01-01T11:00:00Z'),
        recurrence: [rule, 'RDATE:20200101T150000Z'],
        startUtc: at('1990-01-01T10:00:00Z'),
      });
    const from = at('2026-07-03T10:00:00Z');
    expect(drawsFrom(since1990('RRULE:FREQ=DAILY;UNTIL=20260703T095959Z'), from)).toBe(false);
    expect(drawsFrom(since1990('RRULE:FREQ=DAILY'), from)).toBe(true);
  });

  it('draws nothing for a deleted series or a single event', () => {
    const from = at('2026-07-03T10:00:00Z');
    expect(drawsFrom(series({ status: 'cancelled' }), from)).toBe(false);
    expect(drawsFrom(series({ recurrence: undefined }), from)).toBe(false);
  });
});
