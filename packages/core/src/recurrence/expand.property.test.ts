import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { Temporal } from '../time/temporal.ts';
import { compactUtc } from './editing.ts';
import { expandRecurringEvent, type RecurrenceMaster } from './expand.ts';

const Count = Schema.Int.check(Schema.isBetween({ maximum: 24, minimum: 2 }));
const Minutes = Schema.Int.check(Schema.isBetween({ maximum: 180, minimum: 1 }));

it.prop(
  'calendar-day recurrence preserves wall time, duration, exclusions and window boundaries',
  {
    anchor: Schema.Literals(['2024-02-25', '2026-03-01', '2026-10-25', '2026-01-28']),
    count: Count,
    duration: Minutes,
    excluded: Schema.Array(Schema.Boolean).check(Schema.isMaxLength(24)),
    interval: Schema.Literals([1, 2, 7, 14]),
    zone: Schema.Literals([
      'UTC',
      'America/Los_Angeles',
      'Europe/Vienna',
      'Australia/Lord_Howe',
      'Pacific/Auckland',
    ]),
  },
  ({ anchor, count, duration, excluded, interval, zone }) => {
    const date = Temporal.PlainDate.from(anchor);
    // The reference walks calendar dates, independently of the RRULE engine.
    // 09:00 exists once on each date in these zones, including DST days.
    const starts = Array.from(
      { length: count },
      (_, index) =>
        date.add({ days: index * interval }).toZonedDateTime({ plainTime: '09:00', timeZone: zone })
          .epochMilliseconds,
    );
    const start = starts[0]!;
    const end = starts.at(-1)! + 2 * 86_400_000;
    const master: RecurrenceMaster = {
      endUtc: start + duration * 60_000,
      id: 'generated-series',
      isAllDay: false,
      recurrence: [`RRULE:FREQ=DAILY;INTERVAL=${interval};COUNT=${count}`],
      startTimeZone: zone,
      startUtc: start,
    };
    const all = expandRecurringEvent(master, start, end);
    expect(all.map((occurrence) => occurrence.originalStartUtc)).toEqual(starts);
    expect(new Set(all.map((occurrence) => occurrence.originalStartUtc)).size).toBe(count);
    for (const occurrence of all) {
      expect(occurrence.endUtc - occurrence.startUtc).toBe(duration * 60_000);
    }

    const exclusions = starts.filter((_, index) => excluded[index] === true);
    const filtered = expandRecurringEvent(
      {
        ...master,
        recurrence: [
          ...master.recurrence,
          ...exclusions.map((instant) => `EXDATE:${compactUtc(instant)}`),
        ],
      },
      start,
      end,
    );
    expect(filtered.map((occurrence) => occurrence.startUtc)).toEqual(
      starts.filter((instant) => !exclusions.includes(instant)),
    );
    const boundary = starts[Math.floor(count / 2)]! + 30_000;
    expect(expandRecurringEvent(master, boundary, end)).toEqual(
      all.filter((occurrence) => occurrence.endUtc > boundary),
    );
    expect(expandRecurringEvent(master, start, end, new Set(exclusions))).toEqual(filtered);
  },
  { arbitrary: { runs: 150 } },
);
