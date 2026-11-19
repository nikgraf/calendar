import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from '../time/temporal.ts';
import { buildRuleString, EXPANSION_MAX_ITERATIONS, type RecurrenceMaster } from './expand.ts';

/**
 * The occurrence day nearest the visible days, preferring one already
 * in view, then the later one on a tie. All-day dates float independently
 * of the display zone; timed occurrences are compared in that zone.
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
  const previous = rule.previous(start)?.withTimeZone(zone).toPlainDate();
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  return previous.until(first).days < last.until(next).days ? previous : next;
};
