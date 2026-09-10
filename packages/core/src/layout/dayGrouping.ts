import { utcMsToPlainDate } from '../time/convert.ts';
import { dayRange } from '../time/ranges.ts';
import { Temporal } from '../time/temporal.ts';
import type { EventRecord } from '../types.ts';

/**
 * Events keyed by the ISO dates they occupy within `days`, each list
 * ordered like `eventsOnDay` (all-day first, then by start). One pass over
 * the events instead of one `eventsOnDay` filter + sort per cell — the
 * month views called that 42 times per render.
 */
export const groupEventsByDay = (
  events: ReadonlyArray<EventRecord>,
  days: ReadonlyArray<Temporal.PlainDate>,
  timeZone: string,
): ReadonlyMap<string, ReadonlyArray<EventRecord>> => {
  if (days.length === 0) {
    return new Map();
  }
  const first = days[0]!;
  const last = days.at(-1)!;
  const buckets = new Map<string, Array<EventRecord>>(days.map((day) => [day.toString(), []]));
  const push = (iso: string, event: EventRecord) => {
    buckets.get(iso)?.push(event);
  };

  for (const event of events) {
    if (event.isAllDay) {
      const startIso = event.startDate ?? utcMsToPlainDate(event.startUtc);
      const endIso = event.endDate ?? utcMsToPlainDate(event.endUtc);
      // Single-day events can arrive with end === start rather than the next day.
      const endExclusive =
        startIso === endIso
          ? Temporal.PlainDate.from(startIso).add({ days: 1 })
          : Temporal.PlainDate.from(endIso);
      let day = Temporal.PlainDate.from(startIso);
      if (Temporal.PlainDate.compare(day, first) < 0) {
        day = first;
      }
      while (
        Temporal.PlainDate.compare(day, endExclusive) < 0 &&
        Temporal.PlainDate.compare(day, last) <= 0
      ) {
        push(day.toString(), event);
        day = day.add({ days: 1 });
      }
      continue;
    }
    // Timed: every local day the [start, end) span touches.
    for (const day of days) {
      const range = dayRange(day, timeZone);
      if (event.startUtc < range.endUtc && event.endUtc > range.startUtc) {
        push(day.toString(), event);
      }
    }
  }

  for (const list of buckets.values()) {
    list.sort((a, b) => Number(b.isAllDay) - Number(a.isAllDay) || a.startUtc - b.startUtc);
  }
  return buckets;
};
