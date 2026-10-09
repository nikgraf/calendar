import { Option, Schema } from 'effect';
import type { EventRecord } from '../types.ts';

/**
 * What a tap on a notification opens: one occurrence of an event. Read
 * back from the OS or across IPC, so it is decoded, never trusted.
 */
export const NotificationTarget = Schema.Struct({
  accountId: Schema.String,
  calendarId: Schema.String,
  eventId: Schema.String,
  kind: Schema.Literal('event'),
  /**
   * An occurrence of a series: its identity once edited, when its id
   * changes from the drawn `<series>__<start>` to Google's instance id.
   */
  originalStartUtc: Schema.optional(Schema.Number),
  recurringEventId: Schema.optional(Schema.String),
  /** The occurrence's start: which instance of a series, and the day it is on. */
  startUtc: Schema.Number,
});
export type NotificationTarget = typeof NotificationTarget.Type;

/** The target naming this occurrence of `event`: what a tap on its reminder opens. */
export const eventNotificationTarget = (
  event: Pick<
    EventRecord,
    'accountId' | 'calendarId' | 'id' | 'originalStartUtc' | 'recurringEventId' | 'startUtc'
  >,
): NotificationTarget => ({
  accountId: event.accountId,
  calendarId: event.calendarId,
  eventId: event.id,
  kind: 'event',
  ...(event.recurringEventId === undefined
    ? {}
    : {
        originalStartUtc: event.originalStartUtc ?? event.startUtc,
        recurringEventId: event.recurringEventId,
      }),
  startUtc: event.startUtc,
});

const decodeTarget = Schema.decodeUnknownOption(NotificationTarget);

/** A target from a notification's payload, or undefined when it is not one. */
export const parseNotificationTarget = (value: unknown): NotificationTarget | undefined =>
  Option.getOrUndefined(decodeTarget(value));

/** One local notification the platform sink delivers or schedules. */
export interface PlannedNotification {
  readonly body: string;
  /**
   * Epoch ms after which a missed notification is no longer worth showing:
   * an immediate sink catching up after sleep fires only while
   * `fireAt <= now < expiresAt`. Each producer sets its own rule — a
   * birthday stays useful all day, "meeting in 10 minutes" does not.
   */
  readonly expiresAt: number;
  /** Epoch ms of delivery. */
  readonly fireAt: number;
  /** Stable across runs and unique per producer, so a sink can dedupe. */
  readonly key: string;
  /** What a tap opens; none just brings the app forward (a birthday). */
  readonly target?: NotificationTarget | undefined;
  readonly title: string;
}
