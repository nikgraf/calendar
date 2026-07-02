import { describe, expect, it } from 'vitest';
import { plainDateToUtcMs, toZonedDateTime } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';
import { expandRecurringEvent, type RecurrenceMaster } from './expand.ts';

const instant = (iso: string): number => Temporal.Instant.from(iso).epochMilliseconds;

const HOUR = 60 * 60 * 1000;

// Weekly Tuesday 09:00–10:00 in Los Angeles; US DST starts 2026-03-08.
const weeklyLa: RecurrenceMaster = {
  endUtc: instant('2026-03-03T18:00:00Z'),
  id: 'master-1',
  isAllDay: false,
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
  startTimeZone: 'America/Los_Angeles',
  startUtc: instant('2026-03-03T17:00:00Z'), // 09:00 PST
};

describe('expandRecurringEvent', () => {
  it('expands weekly occurrences across the DST boundary at fixed wall-clock time', () => {
    const instances = expandRecurringEvent(
      weeklyLa,
      instant('2026-03-01T00:00:00Z'),
      instant('2026-03-25T00:00:00Z'),
    );

    expect(instances.map((entry) => entry.startUtc)).toEqual([
      instant('2026-03-03T17:00:00Z'), // PST (-08:00)
      instant('2026-03-10T16:00:00Z'), // PDT (-07:00) — wall clock stays 09:00
      instant('2026-03-17T16:00:00Z'),
      instant('2026-03-24T16:00:00Z'),
    ]);
    for (const entry of instances) {
      expect(entry.endUtc - entry.startUtc).toBe(HOUR);
      expect(toZonedDateTime(entry.startUtc, 'America/Los_Angeles').hour).toBe(9);
      expect(entry.masterId).toBe('master-1');
      expect(entry.originalStartUtc).toBe(entry.startUtc);
    }
  });

  it('drops occurrences listed in EXDATE', () => {
    const master: RecurrenceMaster = {
      ...weeklyLa,
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE;TZID=America/Los_Angeles:20260310T090000'],
    };
    const instances = expandRecurringEvent(
      master,
      instant('2026-03-01T00:00:00Z'),
      instant('2026-03-18T00:00:00Z'),
    );
    expect(instances.map((entry) => entry.startUtc)).toEqual([
      instant('2026-03-03T17:00:00Z'),
      instant('2026-03-17T16:00:00Z'),
    ]);
  });

  it('respects COUNT and UNTIL', () => {
    const counted = expandRecurringEvent(
      { ...weeklyLa, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2'] },
      instant('2026-03-01T00:00:00Z'),
      instant('2026-05-01T00:00:00Z'),
    );
    expect(counted).toHaveLength(2);

    const bounded = expandRecurringEvent(
      {
        ...weeklyLa,
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260311T000000Z'],
      },
      instant('2026-03-01T00:00:00Z'),
      instant('2026-05-01T00:00:00Z'),
    );
    expect(bounded.map((entry) => entry.startUtc)).toEqual([
      instant('2026-03-03T17:00:00Z'),
      instant('2026-03-10T16:00:00Z'),
    ]);
  });

  it('excludes occurrences shadowed by overrides', () => {
    const instances = expandRecurringEvent(
      weeklyLa,
      instant('2026-03-01T00:00:00Z'),
      instant('2026-03-18T00:00:00Z'),
      new Set([instant('2026-03-10T16:00:00Z')]),
    );
    expect(instances.map((entry) => entry.startUtc)).toEqual([
      instant('2026-03-03T17:00:00Z'),
      instant('2026-03-17T16:00:00Z'),
    ]);
  });

  it('includes occurrences that start before the range but overlap into it', () => {
    // Daily 23:00–01:00 UTC: the March 4 occurrence overlaps March 5.
    const master: RecurrenceMaster = {
      endUtc: instant('2026-03-05T01:00:00Z'),
      id: 'overlap',
      isAllDay: false,
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
      startTimeZone: 'UTC',
      startUtc: instant('2026-03-04T23:00:00Z'),
    };
    const instances = expandRecurringEvent(
      master,
      instant('2026-03-05T00:00:00Z'),
      instant('2026-03-06T00:00:00Z'),
    );
    expect(instances.map((entry) => entry.startUtc)).toEqual([
      instant('2026-03-04T23:00:00Z'),
      instant('2026-03-05T23:00:00Z'),
    ]);
  });

  it('expands all-day weekly events with date strings and exclusive end', () => {
    // Two-day all-day event (Sat–Sun), weekly.
    const master: RecurrenceMaster = {
      endDate: '2026-07-06',
      endUtc: plainDateToUtcMs('2026-07-06'),
      id: 'allday',
      isAllDay: true,
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=3'],
      startDate: '2026-07-04',
      startTimeZone: 'UTC',
      startUtc: plainDateToUtcMs('2026-07-04'),
    };
    const instances = expandRecurringEvent(
      master,
      plainDateToUtcMs('2026-07-01'),
      plainDateToUtcMs('2026-08-01'),
    );
    expect(instances.map((entry) => [entry.startDate, entry.endDate])).toEqual([
      ['2026-07-04', '2026-07-06'],
      ['2026-07-11', '2026-07-13'],
      ['2026-07-18', '2026-07-20'],
    ]);
    expect(instances[0]!.startUtc).toBe(plainDateToUtcMs('2026-07-04'));
    expect(instances[0]!.endUtc).toBe(plainDateToUtcMs('2026-07-06'));
  });

  it('clips all-day occurrences to the query range by overlap', () => {
    const master: RecurrenceMaster = {
      endDate: '2026-07-06',
      endUtc: plainDateToUtcMs('2026-07-06'),
      id: 'allday',
      isAllDay: true,
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=3'],
      startDate: '2026-07-04',
      startTimeZone: 'UTC',
      startUtc: plainDateToUtcMs('2026-07-04'),
    };
    // Range covering only July 5: the July 4–6 occurrence overlaps it.
    const instances = expandRecurringEvent(
      master,
      plainDateToUtcMs('2026-07-05'),
      plainDateToUtcMs('2026-07-06'),
    );
    expect(instances).toHaveLength(1);
    expect(instances[0]!.startDate).toBe('2026-07-04');
  });
});
