// M0 spike: prove rrule-temporal + @js-temporal/polyfill expand recurrences
// correctly across a DST boundary before building the real recurrence module on it.
import { describe, expect, it } from 'vitest';
import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from '../time/temporal.ts';

describe('rrule-temporal spike', () => {
  it('keeps local wall-clock time across the US spring-forward DST boundary', () => {
    // Weekly Tuesday 09:00 in Los Angeles; DST starts 2026-03-08.
    const rule = new RRuleTemporal({
      dtstart: Temporal.ZonedDateTime.from('2026-03-03T09:00:00[America/Los_Angeles]'),
      rruleString: 'FREQ=WEEKLY;BYDAY=TU;COUNT=3',
    });

    const occurrences = rule.all();
    expect(occurrences).toHaveLength(3);

    for (const occurrence of occurrences) {
      expect(occurrence.hour).toBe(9);
      expect(occurrence.timeZoneId).toBe('America/Los_Angeles');
    }

    // Wall-clock stays 09:00, so the UTC offset shifts from -08:00 to -07:00.
    expect(occurrences[0]!.offset).toBe('-08:00');
    expect(occurrences[1]!.offset).toBe('-07:00');
    expect(
      occurrences[1]!.toInstant().epochMilliseconds - occurrences[0]!.toInstant().epochMilliseconds,
    ).toBe((7 * 24 - 1) * 60 * 60 * 1000);
  });

  it('honors EXDATE when expanding a window', () => {
    const rule = new RRuleTemporal({
      rruleString: [
        'DTSTART;TZID=Europe/Berlin:20260601T120000',
        'RRULE:FREQ=DAILY;COUNT=5',
        'EXDATE;TZID=Europe/Berlin:20260603T120000',
      ].join('\n'),
    });

    const days = rule.all().map((occurrence) => occurrence.day);
    expect(days).toEqual([1, 2, 4, 5]);
  });
});
