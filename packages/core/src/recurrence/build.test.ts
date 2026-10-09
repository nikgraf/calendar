import { describe, expect, it } from 'vite-plus/test';
import { Temporal } from '../time/temporal.ts';
import { buildRecurrenceRule, repeatUntilError } from './build.ts';
import { expandRecurringEvent } from './expand.ts';

/** The local day of the last occurrence of a daily 30-minute series "until Aug 31" starting Aug 25. */
const lastLocalDay = (timeZone: string, hour: number) => {
  const start = Temporal.ZonedDateTime.from({
    day: 25,
    hour,
    month: 8,
    timeZone,
    year: 2026,
  }).epochMilliseconds;
  const instances = expandRecurringEvent(
    {
      endUtc: start + 30 * 60 * 1000,
      id: 'm',
      isAllDay: false,
      recurrence: [
        buildRecurrenceRule({ freq: 'daily', untilDate: '2026-08-31' }, false, timeZone),
      ],
      startTimeZone: timeZone,
      startUtc: start,
    },
    start,
    start + 30 * 24 * 60 * 60 * 1000,
  );
  return Temporal.Instant.fromEpochMilliseconds(instances.at(-1)!.startUtc)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
};

describe('buildRecurrenceRule', () => {
  it('builds a plain rule without interval 1', () => {
    expect(buildRecurrenceRule({ freq: 'daily' }, false, 'UTC')).toBe('RRULE:FREQ=DAILY');
    expect(buildRecurrenceRule({ freq: 'weekly', interval: 1 }, false, 'UTC')).toBe(
      'RRULE:FREQ=WEEKLY',
    );
  });

  it('includes intervals above 1', () => {
    expect(buildRecurrenceRule({ freq: 'weekly', interval: 2 }, false, 'UTC')).toBe(
      'RRULE:FREQ=WEEKLY;INTERVAL=2',
    );
  });

  it('ends after a count', () => {
    expect(buildRecurrenceRule({ count: 10, freq: 'monthly' }, false, 'UTC')).toBe(
      'RRULE:FREQ=MONTHLY;COUNT=10',
    );
  });

  it('ends on a date — its last second in the series’ zone for timed, DATE for all-day', () => {
    const until = { freq: 'daily', untilDate: '2026-08-31' } as const;
    expect(buildRecurrenceRule(until, false, 'UTC')).toBe(
      'RRULE:FREQ=DAILY;UNTIL=20260831T235959Z',
    );
    // PDT is UTC-7, AEST UTC+10: the same local day ends at different instants.
    expect(buildRecurrenceRule(until, false, 'America/Los_Angeles')).toBe(
      'RRULE:FREQ=DAILY;UNTIL=20260901T065959Z',
    );
    expect(buildRecurrenceRule(until, false, 'Australia/Sydney')).toBe(
      'RRULE:FREQ=DAILY;UNTIL=20260831T135959Z',
    );
    expect(buildRecurrenceRule(until, true, 'Australia/Sydney')).toBe(
      'RRULE:FREQ=DAILY;UNTIL=20260831',
    );
  });

  it('a daily series "until Aug 31" has its last occurrence on Aug 31, west and east of UTC', () => {
    // 17:00 in LA is past midnight UTC: an end-of-day-UTC UNTIL lost Aug 31.
    expect(lastLocalDay('America/Los_Angeles', 17)).toBe('2026-08-31');
    // 08:00 in Sydney is the evening before in UTC: it gained Sep 1.
    expect(lastLocalDay('Australia/Sydney', 8)).toBe('2026-08-31');
  });

  it('prefers count when both end conditions are set', () => {
    expect(
      buildRecurrenceRule({ count: 5, freq: 'yearly', untilDate: '2030-01-01' }, false, 'UTC'),
    ).toBe('RRULE:FREQ=YEARLY;COUNT=5');
  });

  it('lists chosen weekdays and an ordinal weekday as BYDAY', () => {
    expect(
      buildRecurrenceRule(
        { byDay: [{ weekday: 'SA' }, { weekday: 'SU' }], freq: 'weekly' },
        false,
        'UTC',
      ),
    ).toBe('RRULE:FREQ=WEEKLY;BYDAY=SA,SU');
    expect(
      buildRecurrenceRule(
        { byDay: [{ ordinal: 2, weekday: 'TU' }], freq: 'monthly' },
        false,
        'UTC',
      ),
    ).toBe('RRULE:FREQ=MONTHLY;BYDAY=2TU');
    expect(
      buildRecurrenceRule(
        { byDay: [{ ordinal: -1, weekday: 'FR' }], count: 6, freq: 'monthly' },
        false,
        'UTC',
      ),
    ).toBe('RRULE:FREQ=MONTHLY;COUNT=6;BYDAY=-1FR');
    expect(buildRecurrenceRule({ byDay: [], freq: 'weekly' }, false, 'UTC')).toBe(
      'RRULE:FREQ=WEEKLY',
    );
  });
});

describe('repeatUntilError', () => {
  it('refuses an end before the first day and accepts the day itself', () => {
    expect(repeatUntilError({ untilDate: '2026-09-19' }, '2026-09-20')).toBe(
      'The repeat must end on or after its first day.',
    );
    expect(repeatUntilError({ untilDate: '2026-09-20' }, '2026-09-20')).toBeUndefined();
    expect(repeatUntilError({ untilDate: '2027-01-01' }, '2026-09-20')).toBeUndefined();
    expect(repeatUntilError({}, '2026-09-20')).toBeUndefined();
  });
});
