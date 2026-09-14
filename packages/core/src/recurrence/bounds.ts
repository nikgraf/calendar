import { RRuleTemporal } from 'rrule-temporal';
import { daysBetweenPlainDates, plainDateToUtcMs, type EpochMs } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';
import { parseRuleParts } from './editing.ts';
import { buildRuleString, EXPANSION_MAX_ITERATIONS, type RecurrenceMaster } from './expand.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Milliseconds one occurrence spans, so a multi-day last occurrence still intersects. */
const durationMs = (master: RecurrenceMaster): number =>
  master.isAllDay
    ? (master.startDate && master.endDate
        ? daysBetweenPlainDates(master.startDate, master.endDate)
        : 1) * DAY_MS
    : master.endUtc - master.startUtc;

/**
 * `20260714T090000Z` / `20260714T090000` / `20260714` (UNTIL forms) →
 * epoch ms, or undefined. A date-only UNTIL on a timed series means the
 * end of that day in the series zone (rrule-temporal reads it the same
 * way), so the bound is never earlier than the last occurrence.
 */
const untilMs = (value: string, timeZone: string, isAllDay: boolean): number | undefined => {
  try {
    if (/^\d{8}$/.test(value)) {
      const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
      return isAllDay
        ? plainDateToUtcMs(date)
        : Temporal.PlainDate.from(date).toZonedDateTime({ plainTime: '23:59:59', timeZone })
            .epochMilliseconds;
    }
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
    if (!match) {
      return undefined;
    }
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
    return match[7] === 'Z'
      ? Temporal.Instant.from(`${iso}Z`).epochMilliseconds
      : Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;
  } catch {
    return undefined;
  }
};

/**
 * When a series is over: the end of its last occurrence, or undefined for
 * a series that never ends (or whose end cannot be told). Stored on the
 * master row so the window query skips series that ended before the range
 * instead of expanding every master ever synced. UNTIL is read off the
 * rule; COUNT enumerates the series once, at write time, bounded by the
 * expansion cap — past it the series counts as endless, which is safe.
 * RDATE-only series (no RRULE) count as endless for now.
 */
export const recurrenceEndUtc = (master: RecurrenceMaster): EpochMs | undefined => {
  const rule = master.recurrence.find((line) => line.toUpperCase().startsWith('RRULE:'));
  // RDATE values may lie past UNTIL or the last COUNT occurrence; such a
  // series counts as endless rather than risk hiding one.
  if (!rule || master.recurrence.some((line) => line.toUpperCase().startsWith('RDATE'))) {
    return undefined;
  }
  const parts = parseRuleParts(rule);
  const until = parts.get('UNTIL');
  if (until !== undefined) {
    const end = untilMs(until, master.startTimeZone, master.isAllDay);
    return end === undefined ? undefined : end + durationMs(master);
  }
  if (parts.get('COUNT') === undefined) {
    return undefined;
  }
  try {
    const occurrences = new RRuleTemporal({
      maxIterations: EXPANSION_MAX_ITERATIONS,
      rruleString: buildRuleString(master),
    }).all();
    const last = occurrences.at(-1);
    if (!last) {
      return master.startUtc + durationMs(master);
    }
    const lastStart = master.isAllDay
      ? plainDateToUtcMs(last.toPlainDate().toString())
      : last.toInstant().epochMilliseconds;
    return lastStart + durationMs(master);
  } catch {
    return undefined;
  }
};
