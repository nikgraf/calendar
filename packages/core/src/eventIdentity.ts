import type { RecurringScope } from './backend.ts';
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

/**
 * Whether deleting `deleted` with `scope` takes `event` with it, as the
 * editors delete: an occurrence with its scope (the one slot, it and the
 * later ones, or the whole series and its master); anything else alone,
 * a series' master with its occurrences.
 */
export const deleteTakes = (
  deleted: Identified & Pick<EventRecord, 'startUtc'>,
  scope: RecurringScope,
  event: Identified & Pick<EventRecord, 'startUtc'>,
): boolean => {
  if (isSameEvent(deleted, event)) {
    return true;
  }
  if (event.accountId !== deleted.accountId || event.calendarId !== deleted.calendarId) {
    return false;
  }
  const master = deleted.recurringEventId;
  if (master === undefined) {
    return event.recurringEventId === deleted.id;
  }
  switch (scope) {
    case 'following':
      return (
        event.recurringEventId === master &&
        (event.originalStartUtc ?? event.startUtc) >= (deleted.originalStartUtc ?? deleted.startUtc)
      );
    case 'instance':
      return false;
    case 'series':
      return event.id === master || event.recurringEventId === master;
  }
};
