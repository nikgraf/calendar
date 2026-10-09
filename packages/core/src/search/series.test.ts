import { describe, expect, it } from 'vite-plus/test';
import { expandRecurringEvent } from '../recurrence/expand.ts';
import { recurrenceMasterOf } from '../recurrence/window.ts';
import { plainDateToUtcMs } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';
import { EventRecord } from '../types.ts';
import { searchWindow } from './results.ts';
import { seriesSearchOccurrences } from './series.ts';

const VIENNA = 'Europe/Vienna';
const NEW_YORK = 'America/New_York';
const MINUTE = 60_000;

/** The instant a wall-clock time names in a zone. */
const at = (wall: string, zone = VIENNA): number =>
  Temporal.PlainDateTime.from(wall).toZonedDateTime(zone).epochMilliseconds;

// The Saturday evening before Vienna leaves summer time.
const now = at('2026-10-24T18:00');

const master = (start: number, recurrence: ReadonlyArray<string>, minutes = 15) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: start + minutes * MINUTE,
    etag: null,
    id: 'series',
    isAllDay: false,
    recurrence,
    startTimeZone: VIENNA,
    startUtc: start,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Series',
    updatedAt: 0,
  });

const occurrences = (
  series: EventRecord,
  options: {
    readonly nowMs?: number;
    readonly slots?: ReadonlySet<number>;
    readonly zone?: string;
  } = {},
) => {
  const nowMs = options.nowMs ?? now;
  const timeZone = options.zone ?? VIENNA;
  const window = searchWindow(nowMs, timeZone);
  return seriesSearchOccurrences(series, options.slots, {
    nowMs,
    rangeEndUtc: window.endUtc,
    rangeStartUtc: window.startUtc,
    timeZone,
  });
};

describe('seriesSearchOccurrences', () => {
  it('finds the next occurrence of a series too frequent to expand over the window at once', () => {
    const hourly = master(at('2026-10-03T00:30'), ['RRULE:FREQ=HOURLY']);
    const window = searchWindow(now, VIENNA);
    // The whole window is past the expander's iteration cap...
    expect(() =>
      expandRecurringEvent(recurrenceMasterOf(hourly), window.startUtc, window.endUtc),
    ).toThrow();
    // ...so it is walked from now: 17:30 is over at 18:00, 18:30 is next.
    expect(occurrences(hourly)).toMatchObject([
      { id: `series__${String(at('2026-10-24T18:30'))}`, recurringEventId: 'series' },
    ]);
  });

  it('counts an occurrence under way as the next one', () => {
    const hourly = master(at('2026-10-03T00:30'), ['RRULE:FREQ=HOURLY'], 45);
    // 17:30–18:15 is still on at 18:00.
    expect(occurrences(hourly)).toMatchObject([{ startUtc: at('2026-10-24T17:30') }]);
  });

  it('falls back to the latest occurrence of a series that is over', () => {
    const weekly = master(at('2026-01-05T09:00'), ['RRULE:FREQ=WEEKLY;UNTIL=20260301T000000Z']);
    expect(occurrences(weekly)).toMatchObject([{ startUtc: at('2026-02-23T09:00') }]);
    const hourly = master(at('2025-01-01T00:30'), ['RRULE:FREQ=HOURLY;UNTIL=20250601T000000Z']);
    expect(occurrences(hourly)).toMatchObject([{ startUtc: Date.UTC(2025, 4, 31, 23, 30) }]);
  });

  it('leaves out the slots an override took over', () => {
    // Mondays at ten; Monday the 26th's slot belongs to an override.
    const weekly = master(at('2026-10-05T10:00'), ['RRULE:FREQ=WEEKLY'], 60);
    expect(occurrences(weekly, { slots: new Set([at('2026-10-26T10:00')]) })).toMatchObject([
      // The week after, past the clock change.
      { startUtc: at('2026-11-02T10:00') },
    ]);
  });

  it("keeps today's all-day occurrence in a zone behind UTC until the day ends there", () => {
    const daily = new EventRecord({
      ...master(0, ['RRULE:FREQ=DAILY']),
      endDate: '2026-10-02',
      endUtc: plainDateToUtcMs('2026-10-02'),
      isAllDay: true,
      startDate: '2026-10-01',
      startTimeZone: undefined,
      startUtc: plainDateToUtcMs('2026-10-01'),
    });
    // 21:00 in New York is already tomorrow in UTC, where today's occurrence ended.
    const evening = at('2026-10-24T21:00', NEW_YORK);
    expect(plainDateToUtcMs('2026-10-25')).toBeLessThan(evening);
    expect(occurrences(daily, { nowMs: evening, zone: NEW_YORK })).toMatchObject([
      { startDate: '2026-10-24' },
    ]);
  });

  it('has nothing to offer for a series without a rule, and throws for a broken one', () => {
    expect(occurrences(master(at('2026-10-05T10:00'), []))).toEqual([]);
    expect(() => occurrences(master(at('2026-10-05T10:00'), ['RRULE:FREQ=NEVER']))).toThrow();
  });
});
