import { describe, expect, it } from 'vitest';
import {
  compactUtc,
  googleInstanceId,
  remainingRecurrence,
  truncateRecurrence,
} from './editing.ts';
import type { RecurrenceMaster } from './expand.ts';

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
