import {
  type BackendClient,
  type EventRecord,
  type NotificationTarget,
  Temporal,
  toZonedDateTime,
} from '@calendar/core';
import { Effect } from 'effect';

const DAY_MS = 86_400_000;

/**
 * The occurrence a tapped notification is about, or null when it is gone.
 * Read through the range query, which also expands a series and reads
 * Apple events through: a day either side covers an all-day event's UTC
 * midnight in any zone. A moved event is still found by its id.
 */
export const findNotificationEvent = (
  client: Pick<BackendClient, 'getEventsInRange'>,
  target: NotificationTarget,
): Promise<EventRecord | null> =>
  Effect.runPromise(
    client
      .getEventsInRange({
        rangeEndUtc: target.startUtc + DAY_MS,
        rangeStartUtc: target.startUtc - DAY_MS,
      })
      .pipe(
        Effect.map((events) => {
          const same = events.filter(
            (event) =>
              event.accountId === target.accountId &&
              event.calendarId === target.calendarId &&
              event.id === target.eventId,
          );
          return same.find((event) => event.startUtc === target.startUtc) ?? same[0] ?? null;
        }),
        Effect.orElseSucceed(() => null),
      ),
  );

/** The day an opened event is shown on: its own date when all-day, else its start in `timeZone`. */
export const eventStartDay = (event: EventRecord, timeZone: string): Temporal.PlainDate =>
  event.isAllDay && event.startDate
    ? Temporal.PlainDate.from(event.startDate)
    : toZonedDateTime(event.startUtc, timeZone).toPlainDate();
