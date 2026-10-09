import type { EventRecord } from './types.ts';

type Identified = Pick<
  EventRecord,
  'accountId' | 'calendarId' | 'id' | 'originalStartUtc' | 'recurringEventId'
>;

const isOccurrence = (event: Identified): boolean =>
  event.recurringEventId !== undefined && event.originalStartUtc !== undefined;

/**
 * Names one event across refreshes of the rows it is drawn from. A single
 * event is its account, calendar and id. An occurrence of a series is its
 * series and original start instead: its id changes once it is edited on
 * its own (the drawn `<series>__<start>` becomes Google's instance id),
 * while the slot it fills does not — an Apple occurrence keeps its slot
 * the same way.
 */
export const eventIdentity = (event: Identified): string =>
  isOccurrence(event)
    ? [
        event.accountId,
        event.calendarId,
        event.recurringEventId,
        String(event.originalStartUtc),
      ].join('\u0000')
    : [event.accountId, event.calendarId, event.id].join('\u0000');

/** Whether two rows are one event (`eventIdentity`), however much changed in between. */
export const isSameEvent = (a: Identified, b: Identified): boolean =>
  a.accountId === b.accountId &&
  a.calendarId === b.calendarId &&
  (isOccurrence(a)
    ? isOccurrence(b) &&
      a.recurringEventId === b.recurringEventId &&
      a.originalStartUtc === b.originalStartUtc
    : !isOccurrence(b) && a.id === b.id);

/** The row in `events` that is `event` now — refreshed, or edited into an override — if any. */
export const findSameEvent = (
  events: ReadonlyArray<EventRecord>,
  event: Identified,
): EventRecord | undefined => events.find((candidate) => isSameEvent(candidate, event));
