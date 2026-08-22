import { dayRange } from '../time/ranges.ts';
import { Temporal } from '../time/temporal.ts';
import { utcMsToPlainDate } from '../time/convert.ts';
import type { EventRecord } from '../types.ts';

/**
 * Whether an event occupies a given local calendar day.
 *
 * All-day events are stored at UTC midnight, so testing their instants
 * against a *local* day window puts them on two days in any zone east of
 * UTC. They are matched on their date strings instead (`endDate` is
 * exclusive, per Google); timed events use the local day window.
 */
export const isEventOnDay = (
  event: EventRecord,
  date: Temporal.PlainDate,
  timeZone: string,
): boolean => {
  if (event.isAllDay) {
    const startIso = event.startDate ?? utcMsToPlainDate(event.startUtc);
    const endIso = event.endDate ?? utcMsToPlainDate(event.endUtc);
    const iso = date.toString();
    // Single-day events can arrive with end === start rather than the next day.
    return startIso === endIso ? iso === startIso : iso >= startIso && iso < endIso;
  }
  const range = dayRange(date, timeZone);
  return event.startUtc < range.endUtc && event.endUtc > range.startUtc;
};

/** Events occupying `date`, all-day first, then by start time. */
export const eventsOnDay = (
  events: ReadonlyArray<EventRecord>,
  date: Temporal.PlainDate,
  timeZone: string,
): Array<EventRecord> =>
  events
    .filter((event) => isEventOnDay(event, date, timeZone))
    .sort((a, b) => Number(b.isAllDay) - Number(a.isAllDay) || a.startUtc - b.startUtc);
