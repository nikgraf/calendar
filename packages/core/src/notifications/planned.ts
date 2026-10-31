import { Option, Schema } from 'effect';
import type { EventRecord, TaskRecord } from '../types.ts';

/**
 * What a tap on an event reminder opens: one occurrence of an event. Read
 * back from the OS or across IPC, so it is decoded, never trusted.
 */
export const EventNotificationTarget = Schema.Struct({
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
export type EventNotificationTarget = typeof EventNotificationTarget.Type;

/** What a tap on a task reminder opens: the task, by its stored identity. */
export const TaskNotificationTarget = Schema.Struct({
  accountId: Schema.String,
  kind: Schema.Literal('task'),
  listId: Schema.String,
  taskId: Schema.String,
});
export type TaskNotificationTarget = typeof TaskNotificationTarget.Type;

/** What a tap on a notification opens; `kind` tells which. */
export const NotificationTarget = Schema.Union([EventNotificationTarget, TaskNotificationTarget]);
export type NotificationTarget = typeof NotificationTarget.Type;

/** The target naming this occurrence of `event`: what a tap on its reminder opens. */
export const eventNotificationTarget = (
  event: Pick<
    EventRecord,
    'accountId' | 'calendarId' | 'id' | 'originalStartUtc' | 'recurringEventId' | 'startUtc'
  >,
): EventNotificationTarget => ({
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

/** The target naming `task`: what a tap on its reminder opens. */
export const taskNotificationTarget = (
  task: Pick<TaskRecord, 'accountId' | 'id' | 'listId'>,
): TaskNotificationTarget => ({
  accountId: task.accountId,
  kind: 'task',
  listId: task.listId,
  taskId: task.id,
});

const decodeTarget = Schema.decodeUnknownOption(NotificationTarget);

/** A target from a notification's payload, or undefined when it is not one. */
export const parseNotificationTarget = (value: unknown): NotificationTarget | undefined =>
  Option.getOrUndefined(decodeTarget(value));

/** One local notification the platform sink delivers or schedules. */
export interface PlannedNotification {
  readonly body: string;
  /**
   * Epoch ms after which a delivered notification is no longer worth
   * keeping in Notification Center: a scheduled sink reads it back from
   * the OS and dismisses (an event reminder once the event is over).
   * Absent, it stays until the user clears it (a birthday). Not
   * `expiresAt`, which bounds showing a missed one.
   */
  readonly dismissAt?: number | undefined;
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
