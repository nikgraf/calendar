import { describe, expect, it } from 'vitest';
import { Temporal } from '../time/temporal.ts';
import { recurrenceEndUtc } from './bounds.ts';
import type { RecurrenceMaster } from './expand.ts';

const instant = (iso: string): number => Temporal.Instant.from(iso).epochMilliseconds;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Weekly Tuesday 09:00–10:00 UTC from 2026-07-07.
const weekly = (recurrence: ReadonlyArray<string>): RecurrenceMaster => ({
  endUtc: instant('2026-07-07T10:00:00Z'),
  id: 'master',
  isAllDay: false,
  recurrence,
  startTimeZone: 'UTC',
  startUtc: instant('2026-07-07T09:00:00Z'),
});

describe('recurrenceEndUtc', () => {
  it('reads UNTIL and adds the occurrence duration', () => {
    expect(recurrenceEndUtc(weekly(['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260728T090000Z']))).toBe(
      instant('2026-07-28T10:00:00Z'),
    );
    // Date-only UNTIL on a timed series: the end of that day in the
    // series zone, so the last occurrence (20:00 that evening) still counts.
    expect(
      recurrenceEndUtc({
        ...weekly(['RRULE:FREQ=WEEKLY;UNTIL=20260728']),
        startTimeZone: 'America/Los_Angeles',
      }),
    ).toBe(instant('2026-07-29T06:59:59Z') + HOUR);
    expect(
      recurrenceEndUtc({
        ...weekly(['RRULE:FREQ=WEEKLY;UNTIL=20260728T090000']),
        startTimeZone: 'Europe/Vienna',
      }),
    ).toBe(instant('2026-07-28T07:00:00Z') + HOUR);
  });

  it('enumerates a COUNT series to its last occurrence', () => {
    expect(recurrenceEndUtc(weekly(['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3']))).toBe(
      instant('2026-07-21T10:00:00Z'),
    );
    // All-day: the last occurrence spans its days.
    expect(
      recurrenceEndUtc({
        endDate: '2026-07-09',
        endUtc: instant('2026-07-09T00:00:00Z'),
        id: 'm',
        isAllDay: true,
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=2'],
        startDate: '2026-07-07',
        startTimeZone: 'UTC',
        startUtc: instant('2026-07-07T00:00:00Z'),
      }),
    ).toBe(instant('2026-07-14T00:00:00Z') + 2 * DAY);
  });

  it('ends a set of only RDATE lines at its latest value, whatever its zone', () => {
    expect(
      recurrenceEndUtc(
        weekly([
          'RDATE;TZID=America/New_York:20260901T090000',
          'RDATE:20260801T090000Z',
          'EXDATE:20260707T090000Z',
        ]),
      ),
    ).toBe(instant('2026-09-01T13:00:00Z') + HOUR);
    // Only DTSTART left: the set ends with it.
    expect(recurrenceEndUtc(weekly(['RDATE:20260707T090000Z']))).toBe(
      instant('2026-07-07T10:00:00Z'),
    );
    // All-day: the last date spans the occurrence's days.
    expect(
      recurrenceEndUtc({
        endDate: '2026-07-09',
        endUtc: instant('2026-07-09T00:00:00Z'),
        id: 'm',
        isAllDay: true,
        recurrence: ['RDATE;VALUE=DATE:20260801,20260715'],
        startDate: '2026-07-07',
        startTimeZone: 'UTC',
        startUtc: instant('2026-07-07T00:00:00Z'),
      }),
    ).toBe(instant('2026-08-01T00:00:00Z') + 2 * DAY);
  });

  it('takes the later of the rule end and the last RDATE', () => {
    // An RDATE past UNTIL / the last COUNT occurrence extends the series…
    expect(
      recurrenceEndUtc(
        weekly(['RRULE:FREQ=WEEKLY;UNTIL=20260714T090000Z', 'RDATE:20260901T090000Z']),
      ),
    ).toBe(instant('2026-09-01T10:00:00Z'));
    expect(recurrenceEndUtc(weekly(['RRULE:FREQ=WEEKLY;COUNT=3', 'RDATE:20260901T090000Z']))).toBe(
      instant('2026-09-01T10:00:00Z'),
    );
    // …one before it does not shorten it.
    expect(
      recurrenceEndUtc(
        weekly(['RRULE:FREQ=WEEKLY;UNTIL=20260728T090000Z', 'RDATE:20260710T090000Z']),
      ),
    ).toBe(instant('2026-07-28T10:00:00Z'));
  });

  it('is undefined for endless, unparseable and runaway series', () => {
    expect(recurrenceEndUtc(weekly(['RRULE:FREQ=WEEKLY;BYDAY=TU']))).toBeUndefined();
    // An endless rule stays endless whatever its RDATE values say.
    expect(
      recurrenceEndUtc(weekly(['RRULE:FREQ=WEEKLY;BYDAY=TU', 'RDATE:20260901T090000Z'])),
    ).toBeUndefined();
    expect(recurrenceEndUtc(weekly(['RRULE:FREQ=WEEKLY;UNTIL=garbage']))).toBeUndefined();
    expect(
      recurrenceEndUtc(weekly(['RRULE:FREQ=WEEKLY;UNTIL=garbage', 'RDATE:20260901T090000Z'])),
    ).toBeUndefined();
    // Past the expansion cap the series counts as endless (safe: never skipped).
    expect(recurrenceEndUtc(weekly(['RRULE:FREQ=DAILY;COUNT=50000']))).toBeUndefined();
  });
});
