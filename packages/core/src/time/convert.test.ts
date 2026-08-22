import { describe, expect, it } from 'vitest';
import {
  addDaysToPlainDate,
  daysBetweenPlainDates,
  plainDateToUtcMs,
  toZonedDateTime,
  utcMsToPlainDate,
} from './convert.ts';

describe('convert', () => {
  it('indexes all-day dates at UTC midnight regardless of local zone', () => {
    expect(plainDateToUtcMs('2026-08-22')).toBe(Date.parse('2026-08-22T00:00:00Z'));
    expect(utcMsToPlainDate(Date.parse('2026-08-22T00:00:00Z'))).toBe('2026-08-22');
    // Late-evening UTC still belongs to the same UTC date.
    expect(utcMsToPlainDate(Date.parse('2026-08-22T23:59:59Z'))).toBe('2026-08-22');
  });

  it('round-trips a date through UTC milliseconds', () => {
    for (const iso of ['2026-01-01', '2026-03-29', '2026-12-31']) {
      expect(utcMsToPlainDate(plainDateToUtcMs(iso))).toBe(iso);
    }
  });

  it('converts instants into a zone, including across a DST boundary', () => {
    const before = toZonedDateTime(Date.parse('2026-03-29T00:30:00Z'), 'Europe/Vienna');
    const after = toZonedDateTime(Date.parse('2026-03-29T01:30:00Z'), 'Europe/Vienna');
    // Vienna jumps from 02:00 to 03:00 that night: +1 then +2.
    expect(before.hour).toBe(1);
    expect(after.hour).toBe(3);
  });

  it('adds days and measures spans across month and year ends', () => {
    expect(addDaysToPlainDate('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDaysToPlainDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetweenPlainDates('2026-08-22', '2026-08-25')).toBe(3);
    expect(daysBetweenPlainDates('2026-08-25', '2026-08-22')).toBe(-3);
    expect(daysBetweenPlainDates('2026-08-22', '2026-08-22')).toBe(0);
    // A leap day must count.
    expect(daysBetweenPlainDates('2028-02-28', '2028-03-01')).toBe(2);
  });
});
