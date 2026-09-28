import { Temporal } from '../time/temporal.ts';
import type { TaskRecurrence } from '../types.ts';
import { byDayError } from './byDay.ts';
import { toStructuredRules } from './structured.ts';

/**
 * An event's recurrence lines as the rule a Reminder can hold, or
 * undefined when they say more than `TaskRecurrence` can: several rules,
 * EXDATE/RDATE lines, month-day or position lists, a BYDAY shape the
 * reminder form refuses. Converting an event to a reminder carries the
 * rule when this returns one and names "the repeat rule" as lost
 * otherwise.
 */
export const taskRecurrenceFromLines = (
  lines: ReadonlyArray<string> | undefined,
  {
    isAllDay,
    startTime,
    timeZone = 'UTC',
  }: {
    readonly isAllDay: boolean;
    /** Timed series: the occurrences' wall-clock start ('HH:MM'), to place UNTIL on its last day. */
    readonly startTime?: string | undefined;
    readonly timeZone?: string | undefined;
  },
): TaskRecurrence | undefined => {
  if (lines === undefined || lines.length === 0) {
    return undefined;
  }
  const { rules, unsupported } = toStructuredRules(lines, isAllDay, timeZone);
  const [rule] = rules;
  if (unsupported.length > 0 || rules.length !== 1 || rule === undefined) {
    return undefined;
  }
  if (rule.byMonth || rule.byMonthDay || rule.bySetPos || rule.byWeekNo || rule.byYearDay) {
    return undefined;
  }
  if (byDayError(rule) !== undefined) {
    return undefined;
  }
  const untilDate = rule.untilDate ?? lastDayOf(rule.untilUtc, startTime, timeZone);
  return {
    ...(rule.byDay ? { byDay: rule.byDay } : {}),
    ...(rule.count === undefined ? {} : { count: rule.count }),
    freq: rule.freq,
    interval: rule.interval,
    ...(untilDate === undefined ? {} : { untilDate }),
  };
};

/**
 * The last day a timed series occurs on: the day of the UNTIL instant in
 * `timeZone`, or the day before when that day's occurrence would already
 * start after the instant (`UNTIL=…T235959Z` read east of UTC).
 */
const lastDayOf = (
  untilUtc: number | undefined,
  startTime: string | undefined,
  timeZone: string,
): string | undefined => {
  if (untilUtc === undefined) {
    return undefined;
  }
  const until = Temporal.Instant.fromEpochMilliseconds(untilUtc).toZonedDateTimeISO(timeZone);
  const day = until.toPlainDate();
  if (startTime === undefined || !/^\d{2}:\d{2}$/.test(startTime)) {
    return day.toString();
  }
  const occurrence = day.toZonedDateTime({ plainTime: `${startTime}:00`, timeZone });
  return (
    Temporal.Instant.compare(occurrence.toInstant(), until.toInstant()) > 0
      ? day.subtract({ days: 1 })
      : day
  ).toString();
};
