import { Temporal } from '../time/temporal.ts';
import { type ByDay, formatByDay } from './byDay.ts';
import { compactUtc } from './editing.ts';

/**
 * Builds the RRULE line for the editor's repeat picker. The rule leans on
 * RFC 5545 defaults: without BYDAY/BYMONTHDAY the series recurs on the
 * weekday/day-of-month of DTSTART; the pickers add BYDAY only for chosen
 * weekdays ("weekends") or an "Nth weekday of the month".
 */

export type RecurrenceFrequency = 'daily' | 'monthly' | 'weekly' | 'yearly';

export interface RecurrenceRuleSpec {
  /** Weekly: the weekdays; monthly: one weekday with its ordinal. See `byDayError`. */
  readonly byDay?: ReadonlyArray<ByDay> | undefined;
  /** End after this many occurrences; wins over untilDate if both are set. */
  readonly count?: number | undefined;
  readonly freq: RecurrenceFrequency;
  /** Every n days/weeks/months/years; omitted when 1. */
  readonly interval?: number | undefined;
  /** Inclusive last day, 'YYYY-MM-DD'. */
  readonly untilDate?: string | undefined;
}

/**
 * `timeZone` is the series' own (its startTimeZone): a timed series ends
 * at the last second of `untilDate` there, written in UTC as RFC 5545
 * asks — the day's end in UTC would drop the last day west of UTC and add
 * one east of it. An all-day series ends on the DATE itself.
 */
export const buildRecurrenceRule = (
  spec: RecurrenceRuleSpec,
  isAllDay: boolean,
  timeZone: string,
): string => {
  const parts = [`FREQ=${spec.freq.toUpperCase()}`];
  if (spec.interval !== undefined && spec.interval > 1) {
    parts.push(`INTERVAL=${Math.floor(spec.interval)}`);
  }
  if (spec.count !== undefined && spec.count > 0) {
    parts.push(`COUNT=${Math.floor(spec.count)}`);
  } else if (spec.untilDate) {
    parts.push(
      `UNTIL=${isAllDay ? spec.untilDate.replaceAll('-', '') : endOfDayUtc(spec.untilDate, timeZone)}`,
    );
  }
  if (spec.byDay !== undefined && spec.byDay.length > 0) {
    parts.push(`BYDAY=${formatByDay(spec.byDay)}`);
  }
  return `RRULE:${parts.join(';')}`;
};

/** The last second of `date` in `timeZone`, as `YYYYMMDDTHHMMSSZ`. */
const endOfDayUtc = (date: string, timeZone: string): string =>
  compactUtc(
    Temporal.PlainDate.from(date).add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds -
      1000,
  );
