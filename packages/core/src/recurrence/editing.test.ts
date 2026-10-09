import { describe, expect, it } from 'vite-plus/test';
import {
  compactUtc,
  googleInstanceId,
  isRecurringSet,
  remainingRecurrence,
  truncateRecurrence,
} from './editing.ts';
import { expandRecurringEvent, type RecurrenceMaster } from './expand.ts';

const instant = (iso: string): number => Date.parse(iso);

describe('recurrence editing helpers', () => {
  it('formats compact UTC basetimes', () => {
    expect(compactUtc(instant('2026-07-06T09:30:00Z'))).toBe('20260706T093000Z');
  });

  it('builds Google instance ids for timed and all-day events', () => {
    expect(googleInstanceId('master1', instant('2026-07-06T09:30:00Z'), false)).toBe(
      'master1_20260706T093000Z',
    );
    expect(googleInstanceId('master1', instant('2026-07-06T00:00:00Z'), true)).toBe(
      'master1_20260706',
    );
  });

  it('truncates an RRULE with UNTIL one second before the split', () => {
    expect(
      truncateRecurrence(['RRULE:FREQ=DAILY;COUNT=10'], instant('2026-07-06T09:00:00Z'), false),
    ).toEqual(['RRULE:FREQ=DAILY;UNTIL=20260706T085959Z']);
  });

  it('replaces an existing UNTIL and keeps EXDATE lines untouched', () => {
    expect(
      truncateRecurrence(
        ['RRULE:FREQ=WEEKLY;UNTIL=20270101T000000Z', 'EXDATE;TZID=Europe/Vienna:20260721T090000'],
        instant('2026-07-14T07:00:00Z'),
        false,
      ),
    ).toEqual([
      'RRULE:FREQ=WEEKLY;UNTIL=20260714T065959Z',
      'EXDATE;TZID=Europe/Vienna:20260721T090000',
    ]);
  });

  it('prunes RDATE occurrences at or after the split, in every value form', () => {
    expect(
      truncateRecurrence(
        [
          'RRULE:FREQ=WEEKLY',
          // UTC, wall clock in a zone, floating (series zone), and DATE.
          'RDATE:20260707T070000Z,20260721T070000Z',
          'RDATE;TZID=Europe/Vienna:20260708T090000,20260722T090000',
          'RDATE:20260709T090000,20260723T090000',
          'RDATE;VALUE=DATE:20260710,20260724',
          'EXDATE;TZID=Europe/Vienna:20260728T090000',
        ],
        instant('2026-07-14T07:00:00Z'),
        false,
        'Europe/Vienna',
      ),
    ).toEqual([
      'RRULE:FREQ=WEEKLY;UNTIL=20260714T065959Z',
      'RDATE:20260707T070000Z',
      'RDATE;TZID=Europe/Vienna:20260708T090000',
      'RDATE:20260709T090000',
      'RDATE;VALUE=DATE:20260710',
      'EXDATE;TZID=Europe/Vienna:20260728T090000',
    ]);
  });

  it('drops an RDATE line whose every occurrence is past the split', () => {
    expect(
      truncateRecurrence(
        ['RRULE:FREQ=WEEKLY', 'RDATE:20260721T070000Z'],
        instant('2026-07-14T07:00:00Z'),
        false,
      ),
    ).toEqual(['RRULE:FREQ=WEEKLY;UNTIL=20260714T065959Z']);
  });

  it('uses a DATE-valued UNTIL for all-day series', () => {
    expect(
      truncateRecurrence(['RRULE:FREQ=WEEKLY'], instant('2026-07-06T00:00:00Z'), true),
    ).toEqual(['RRULE:FREQ=WEEKLY;UNTIL=20260705']);
  });

  it('computes the remaining COUNT for the new master after a split', () => {
    const master: RecurrenceMaster = {
      endUtc: instant('2026-07-01T10:00:00Z'),
      id: 'm',
      isAllDay: false,
      recurrence: ['RRULE:FREQ=DAILY;COUNT=10'],
      startTimeZone: 'UTC',
      startUtc: instant('2026-07-01T09:00:00Z'),
    };
    // Split at the 4th occurrence (July 4) — 3 consumed, 7 remain.
    expect(remainingRecurrence(master, instant('2026-07-04T09:00:00Z'))).toEqual([
      'RRULE:FREQ=DAILY;COUNT=7',
    ]);
  });

  it('counts only what the RRULE generated toward the remaining COUNT', () => {
    const master: RecurrenceMaster = {
      endUtc: instant('2026-07-01T10:00:00Z'),
      id: 'm',
      isAllDay: false,
      // An extra date and an excluded occurrence, both before the split.
      recurrence: [
        'RRULE:FREQ=DAILY;COUNT=10',
        'RDATE:20260620T090000Z',
        'EXDATE:20260702T090000Z',
      ],
      startTimeZone: 'UTC',
      startUtc: instant('2026-07-01T09:00:00Z'),
    };
    // Split on July 4: July 1–3 were generated (July 2 excluded still counts).
    expect(remainingRecurrence(master, instant('2026-07-04T09:00:00Z'))).toEqual([
      'RRULE:FREQ=DAILY;COUNT=7',
      'EXDATE:20260702T090000Z',
    ]);
  });

  it('keeps only RDATE values after the split for the new master', () => {
    const master: RecurrenceMaster = {
      endUtc: instant('2026-07-01T10:00:00Z'),
      id: 'm',
      isAllDay: false,
      recurrence: [
        'RRULE:FREQ=WEEKLY',
        'RDATE:20260703T090000Z,20260714T090000Z,20260720T090000Z',
        'RDATE;VALUE=DATE:20260705',
      ],
      startTimeZone: 'UTC',
      startUtc: instant('2026-07-01T09:00:00Z'),
    };
    // The value at the split is the new DTSTART; earlier ones stay with the old series.
    expect(remainingRecurrence(master, instant('2026-07-14T09:00:00Z'))).toEqual([
      'RRULE:FREQ=WEEKLY',
      'RDATE:20260720T090000Z',
    ]);
  });

  describe('a split keeps every occurrence, in exactly one half', () => {
    // Wednesdays from July 1, four times, plus a Friday (July 10) by RDATE.
    const wednesdays: RecurrenceMaster = {
      endUtc: instant('2026-07-01T10:00:00Z'),
      id: 'm',
      isAllDay: false,
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4', 'RDATE:20260710T090000Z'],
      startTimeZone: 'UTC',
      startUtc: instant('2026-07-01T09:00:00Z'),
    };
    const HOUR = 60 * 60 * 1000;
    const starts = (master: RecurrenceMaster): Array<string> =>
      expandRecurringEvent(
        master,
        instant('2026-06-01T00:00:00Z'),
        instant('2026-09-01T00:00:00Z'),
      ).map((entry) => new Date(entry.startUtc).toISOString().slice(0, 16));
    const split = (master: RecurrenceMaster, at: number) => ({
      head: starts({ ...master, recurrence: truncateRecurrence(master.recurrence, at, false) }),
      tail: starts({
        ...master,
        endUtc: at + HOUR,
        recurrence: remainingRecurrence(master, at),
        startUtc: at,
      }),
    });

    it('on an RDATE occurrence the rule skips: it starts the new half', () => {
      // The new master's DTSTART is a Friday its Wednesday rule skips —
      // still its first occurrence, as on Google, and not counted in COUNT.
      expect(remainingRecurrence(wednesdays, instant('2026-07-10T09:00:00Z'))).toEqual([
        'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=2',
      ]);
      expect(split(wednesdays, instant('2026-07-10T09:00:00Z'))).toEqual({
        head: ['2026-07-01T09:00', '2026-07-08T09:00'],
        tail: ['2026-07-10T09:00', '2026-07-15T09:00', '2026-07-22T09:00'],
      });
    });

    it('on an occurrence the rule generates', () => {
      expect(remainingRecurrence(wednesdays, instant('2026-07-15T09:00:00Z'))).toEqual([
        'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=2',
      ]);
      expect(split(wednesdays, instant('2026-07-15T09:00:00Z'))).toEqual({
        head: ['2026-07-01T09:00', '2026-07-08T09:00', '2026-07-10T09:00'],
        tail: ['2026-07-15T09:00', '2026-07-22T09:00'],
      });
    });

    it('counts COUNT from the rule, not from a DTSTART the rule skips', () => {
      // A Tuesday start with a Wednesday rule: Tuesday, then three Wednesdays.
      const offRule: RecurrenceMaster = {
        ...wednesdays,
        endUtc: instant('2026-06-30T10:00:00Z'),
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=3'],
        startUtc: instant('2026-06-30T09:00:00Z'),
      };
      expect(starts(offRule)).toEqual([
        '2026-06-30T09:00',
        '2026-07-01T09:00',
        '2026-07-08T09:00',
        '2026-07-15T09:00',
      ]);
      expect(split(offRule, instant('2026-07-08T09:00:00Z'))).toEqual({
        head: ['2026-06-30T09:00', '2026-07-01T09:00'],
        tail: ['2026-07-08T09:00', '2026-07-15T09:00'],
      });
    });

    it('on an all-day RDATE occurrence the rule skips', () => {
      // Saturdays from July 4, plus Monday July 13.
      const saturdays: RecurrenceMaster = {
        endDate: '2026-07-05',
        endUtc: instant('2026-07-05T00:00:00Z'),
        id: 'm',
        isAllDay: true,
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=3', 'RDATE;VALUE=DATE:20260713'],
        startDate: '2026-07-04',
        startTimeZone: 'UTC',
        startUtc: instant('2026-07-04T00:00:00Z'),
      };
      const at = instant('2026-07-13T00:00:00Z');
      const tail = remainingRecurrence(saturdays, at);
      expect(tail).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=1']);
      expect(
        expandRecurringEvent(
          {
            ...saturdays,
            endDate: '2026-07-14',
            recurrence: tail,
            startDate: '2026-07-13',
            startUtc: at,
          },
          instant('2026-07-01T00:00:00Z'),
          instant('2026-09-01T00:00:00Z'),
        ).map((entry) => entry.startDate),
      ).toEqual(['2026-07-13', '2026-07-18']);
    });
  });

  describe('a set of only RDATE lines', () => {
    const rdateOnly: RecurrenceMaster = {
      endUtc: instant('2026-07-01T10:00:00Z'),
      id: 'm',
      isAllDay: false,
      recurrence: ['RDATE:20260801T090000Z,20260901T090000Z', 'EXDATE:20260815T090000Z'],
      startTimeZone: 'UTC',
      startUtc: instant('2026-07-01T09:00:00Z'),
    };

    it('splits into the values before and after the occurrence', () => {
      expect(
        truncateRecurrence(rdateOnly.recurrence, instant('2026-09-01T09:00:00Z'), false),
      ).toEqual(['RDATE:20260801T090000Z', 'EXDATE:20260815T090000Z']);
      expect(remainingRecurrence(rdateOnly, instant('2026-08-01T09:00:00Z'))).toEqual([
        'RDATE:20260901T090000Z',
        'EXDATE:20260815T090000Z',
      ]);
    });

    it('keeps the old master a series of DTSTART when no value precedes the split', () => {
      const truncated = truncateRecurrence(
        rdateOnly.recurrence,
        instant('2026-08-01T09:00:00Z'),
        false,
      );
      expect(truncated).toEqual(['RRULE:FREQ=DAILY;COUNT=1', 'EXDATE:20260815T090000Z']);
      expect(isRecurringSet(truncated)).toBe(true);
    });

    it('leaves nothing to repeat for the new half of a split on the last value', () => {
      const remaining = remainingRecurrence(rdateOnly, instant('2026-09-01T09:00:00Z'));
      expect(remaining).toEqual(['EXDATE:20260815T090000Z']);
      expect(isRecurringSet(remaining)).toBe(false);
    });
  });

  it('keeps UNTIL rules unchanged for the new master', () => {
    const master: RecurrenceMaster = {
      endUtc: instant('2026-07-01T10:00:00Z'),
      id: 'm',
      isAllDay: false,
      recurrence: ['RRULE:FREQ=DAILY;UNTIL=20260731T090000Z'],
      startTimeZone: 'UTC',
      startUtc: instant('2026-07-01T09:00:00Z'),
    };
    expect(remainingRecurrence(master, instant('2026-07-04T09:00:00Z'))).toEqual([
      'RRULE:FREQ=DAILY;UNTIL=20260731T090000Z',
    ]);
  });
});
