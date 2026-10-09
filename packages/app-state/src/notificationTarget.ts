import {
  type BackendClient,
  eventNotificationTarget,
  type EventRecord,
  googleInstanceId,
  type NotificationTarget,
  Temporal,
  toZonedDateTime,
} from '@calendar/core';
import { Effect } from 'effect';

const DAY_MS = 86_400_000;

type EventLookupClient = Pick<BackendClient, 'getEvent' | 'getEventsInRange'>;

/**
 * An occurrence as stored now, or null when it is gone. Read through the
 * range query, which also expands a series and reads Apple events
 * through: a day either side covers an all-day event's UTC midnight in
 * any zone. An occurrence edited since has a new id, so it is also
 * matched by its series and original start. An event moved out of that
 * window is read by its stored id — a Google event's own, or the instance
 * id an edited occurrence is stored under (Apple events are read through
 * and never stored). A cancelled record found there is a deleted
 * occurrence, kept so the series stops drawing it: gone too.
 */
const lookUpEvent = (client: EventLookupClient, target: NotificationTarget) =>
  Effect.gen(function* () {
    const events = yield* client.getEventsInRange({
      rangeEndUtc: target.startUtc + DAY_MS,
      rangeStartUtc: target.startUtc - DAY_MS,
    });
    const same = events.filter(
      (event) =>
        event.accountId === target.accountId &&
        event.calendarId === target.calendarId &&
        (event.id === target.eventId ||
          (target.recurringEventId !== undefined &&
            event.recurringEventId === target.recurringEventId &&
            event.originalStartUtc === target.originalStartUtc)),
    );
    const found = same.find((event) => event.startUtc === target.startUtc) ?? same[0];
    if (found) {
      return found;
    }
    const storedIds =
      target.recurringEventId === undefined || target.originalStartUtc === undefined
        ? [target.eventId]
        : [
            target.eventId,
            googleInstanceId(target.recurringEventId, target.originalStartUtc, false),
            googleInstanceId(target.recurringEventId, target.originalStartUtc, true),
          ];
    for (const eventId of storedIds) {
      const stored = yield* client.getEvent({
        accountId: target.accountId,
        calendarId: target.calendarId,
        eventId,
      });
      if (stored && stored.status !== 'cancelled') {
        return stored;
      }
    }
    return null;
  });

/** The occurrence a tapped notification is about, or null when it is gone (or unreadable). */
export const findNotificationEvent = (
  client: EventLookupClient,
  target: NotificationTarget,
): Promise<EventRecord | null> =>
  Effect.runPromise(lookUpEvent(client, target).pipe(Effect.orElseSucceed(() => null)));

/**
 * Where an event on screen is now: its row as stored (with any edit made
 * since it was read), or null once it is gone — deleted, or out of reach
 * of the lookup a tapped notification makes. Rejects when the backend
 * cannot say, which is not the same as gone.
 */
export const findCurrentEvent = (
  client: EventLookupClient,
  event: EventRecord,
): Promise<EventRecord | null> =>
  Effect.runPromise(lookUpEvent(client, eventNotificationTarget(event)));

/** The day an opened event is shown on: its own date when all-day, else its start in `timeZone`. */
export const eventStartDay = (event: EventRecord, timeZone: string): Temporal.PlainDate =>
  event.isAllDay && event.startDate
    ? Temporal.PlainDate.from(event.startDate)
    : toZonedDateTime(event.startUtc, timeZone).toPlainDate();
