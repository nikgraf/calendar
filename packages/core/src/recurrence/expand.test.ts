import { describe, expect, it } from 'vite-plus/test';
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

// 09:00–10:00 Vienna on 2026-07-01, then explicit dates only.
const rdateOnly = (recurrence: ReadonlyArray<string>): RecurrenceMaster => ({
  endUtc: instant('2026-07-01T08:00:00Z'),
  id: 'rdate',
  isAllDay: false,
  recurrence,
  startTimeZone: 'Europe/Vienna',
  startUtc: instant('2026-07-01T07:00:00Z'),
});

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

  describe('a set of only RDATE lines', () => {
    it('expands DTSTART plus every RDATE value, in any value form', () => {
      const instances = expandRecurringEvent(
        rdateOnly([
          'RDATE:20260801T070000Z',
          'RDATE;TZID=America/New_York:20260901T090000',
          'RDATE:20261001T090000', // floating: the series zone
        ]),
        instant('2026-06-01T00:00:00Z'),
        instant('2027-01-01T00:00:00Z'),
      );
      expect(instances.map((entry) => entry.startUtc)).toEqual([
        instant('2026-07-01T07:00:00Z'),
        instant('2026-08-01T07:00:00Z'),
        instant('2026-09-01T13:00:00Z'),
        instant('2026-10-01T07:00:00Z'),
      ]);
      for (const entry of instances) {
        expect(entry.endUtc - entry.startUtc).toBe(HOUR);
        expect(entry.originalStartUtc).toBe(entry.startUtc);
      }
    });

    it('drops DTSTART when an EXDATE names it', () => {
      const instances = expandRecurringEvent(
        rdateOnly(['RDATE:20260801T070000Z', 'EXDATE;TZID=Europe/Vienna:20260701T090000']),
        instant('2026-06-01T00:00:00Z'),
        instant('2027-01-01T00:00:00Z'),
      );
      expect(instances.map((entry) => entry.startUtc)).toEqual([instant('2026-08-01T07:00:00Z')]);
    });

    it('returns only the values inside a window far past DTSTART', () => {
      const instances = expandRecurringEvent(
        rdateOnly(['RDATE:20360801T070000Z,20360815T070000Z']),
        instant('2036-08-10T00:00:00Z'),
        instant('2036-08-20T00:00:00Z'),
      );
      expect(instances.map((entry) => entry.startUtc)).toEqual([instant('2036-08-15T07:00:00Z')]);
    });

    it('expands all-day dates', () => {
      const instances = expandRecurringEvent(
        {
          endDate: '2026-07-02',
          endUtc: plainDateToUtcMs('2026-07-02'),
          id: 'allday-rdate',
          isAllDay: true,
          recurrence: ['RDATE;VALUE=DATE:20260801,20260901'],
          startDate: '2026-07-01',
          startTimeZone: 'UTC',
          startUtc: plainDateToUtcMs('2026-07-01'),
        },
        plainDateToUtcMs('2026-06-01'),
        plainDateToUtcMs('2027-01-01'),
      );
      expect(instances.map((entry) => [entry.startDate, entry.endDate])).toEqual([
        ['2026-07-01', '2026-07-02'],
        ['2026-08-01', '2026-08-02'],
        ['2026-09-01', '2026-09-02'],
      ]);
    });
  });

  it('draws a DTSTART its rule skips as the first occurrence, outside COUNT', () => {
    // What Google does (probed live 2026-10-04): a Tuesday start with a
    // Sunday rule, COUNT=2 → the Tuesday plus two Sundays.
    const instances = expandRecurringEvent(
      {
        endUtc: instant('2026-10-06T22:00:00Z'),
        id: 'off-rule',
        isAllDay: false,
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=2'],
        startTimeZone: 'UTC',
        startUtc: instant('2026-10-06T21:00:00Z'),
      },
      instant('2026-10-01T00:00:00Z'),
      instant('2026-11-01T00:00:00Z'),
    );
    expect(instances.map((entry) => entry.startUtc)).toEqual([
      instant('2026-10-06T21:00:00Z'),
      instant('2026-10-11T21:00:00Z'),
      instant('2026-10-18T21:00:00Z'),
    ]);
  });

  it('adds RDATE values to an RRULE', () => {
    const instances = expandRecurringEvent(
      {
        ...weeklyLa,
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2', 'RDATE:20260320T170000Z'],
      },
      instant('2026-03-01T00:00:00Z'),
      instant('2026-04-01T00:00:00Z'),
    );
    expect(instances.map((entry) => entry.startUtc)).toEqual([
      instant('2026-03-03T17:00:00Z'),
      instant('2026-03-10T16:00:00Z'),
      instant('2026-03-20T17:00:00Z'),
    ]);
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
