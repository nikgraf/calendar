import { describe, expect, it } from 'vitest';
import { buildRecurrenceRule } from './build.ts';

describe('buildRecurrenceRule', () => {
  it('builds a plain rule without interval 1', () => {
    expect(buildRecurrenceRule({ freq: 'daily' }, false)).toBe('RRULE:FREQ=DAILY');
    expect(buildRecurrenceRule({ freq: 'weekly', interval: 1 }, false)).toBe('RRULE:FREQ=WEEKLY');
  });

  it('includes intervals above 1', () => {
    expect(buildRecurrenceRule({ freq: 'weekly', interval: 2 }, false)).toBe(
      'RRULE:FREQ=WEEKLY;INTERVAL=2',
    );
  });

  it('ends after a count', () => {
    expect(buildRecurrenceRule({ count: 10, freq: 'monthly' }, false)).toBe(
      'RRULE:FREQ=MONTHLY;COUNT=10',
    );
  });

  it('ends on a date — end-of-day UTC for timed, DATE for all-day', () => {
    expect(buildRecurrenceRule({ freq: 'daily', untilDate: '2026-08-31' }, false)).toBe(
      'RRULE:FREQ=DAILY;UNTIL=20260831T235959Z',
    );
    expect(buildRecurrenceRule({ freq: 'daily', untilDate: '2026-08-31' }, true)).toBe(
      'RRULE:FREQ=DAILY;UNTIL=20260831',
    );
  });

  it('prefers count when both end conditions are set', () => {
    expect(buildRecurrenceRule({ count: 5, freq: 'yearly', untilDate: '2030-01-01' }, false)).toBe(
      'RRULE:FREQ=YEARLY;COUNT=5',
    );
  });
});
