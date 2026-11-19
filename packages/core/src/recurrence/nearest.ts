import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from '../time/temporal.ts';
import { daysBetweenPlainDates, toZonedDateTime } from '../time/convert.ts';
import { buildRuleString, EXPANSION_MAX_ITERATIONS, type RecurrenceMaster } from './expand.ts';

/**
 * The occurrence day nearest the visible days, preferring one already
 * in view (including one continuing from an earlier day), then the later
 * one on a tie. An overlap returns a day inside the view; otherwise its
 * start day. Distance is measured from the occurrence's nearest edge.
 * All-day dates float; timed occurrences use the display zone.
 */
export const nearestOccurrenceDay = (
  master: RecurrenceMaster,
  first: Temporal.PlainDate,
  last: Temporal.PlainDate,
  timeZone: string,
): Temporal.PlainDate | undefined => {
  const zone = master.isAllDay ? 'UTC' : timeZone;
  const start = first.toZonedDateTime(zone);
  const rule = new RRuleTemporal({
    maxIterations: EXPANSION_MAX_ITERATIONS,
    rruleString: buildRuleString(master),
    temporal: Temporal,
  });
  const next = rule.next(start, true)?.withTimeZone(zone).toPlainDate();
  if (next && Temporal.PlainDate.compare(next, last) <= 0) {
    return next;
  }
  const previous = rule.previous(start)?.withTimeZone(zone);
  if (!previous) {
    return next;
  }
  const previousDay = previous.toPlainDate();
  const previousLast =
    master.isAllDay && master.startDate && master.endDate
      ? previousDay.add({
          days: Math.max(0, daysBetweenPlainDates(master.startDate, master.endDate) - 1),
        })
      : toZonedDateTime(
          previous.epochMilliseconds + Math.max(0, master.endUtc - master.startUtc - 1),
          zone,
        ).toPlainDate();
  if (Temporal.PlainDate.compare(previousLast, first) >= 0) {
    return first;
  }
  if (!next) {
    return previousDay;
  }
  return previousLast.until(first).days < last.until(next).days ? previousDay : next;
};
