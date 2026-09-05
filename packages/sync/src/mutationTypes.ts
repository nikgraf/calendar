import type {
  EventDraft,
  EventRecord,
  RecurringScope,
  RsvpResponse,
  TaskPriority,
  TaskProvider,
  TaskRecord,
  TaskRecurrence,
} from '@calendar/core';
import type { RemindersError } from '@calendar/reminders';
import { Data, type Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';

export class EventNotFoundError extends Data.TaggedError('EventNotFoundError')<{
  readonly eventId: string;
}> {}

/**
 * Raised when a plain edit targets a recurring master/override (those go
 * through updateRecurring/deleteRecurring) or a recurring edit targets a
 * non-recurring event.
 */
export class RecurringEditUnsupportedError extends Data.TaggedError(
  'RecurringEditUnsupportedError',
)<{ readonly eventId: string }> {}

/** The signed-in account is not on the event's guest list. */
export class NotAttendeeError extends Data.TaggedError('NotAttendeeError')<{
  readonly eventId: string;
}> {}

export class InvalidColorError extends Data.TaggedError('InvalidColorError')<{
  readonly colorHex: string;
}> {}

export class TaskNotFoundError extends Data.TaggedError('TaskNotFoundError')<{
  readonly taskId: string;
}> {}

export class TaskListNotFoundError extends Data.TaggedError('TaskListNotFoundError')<{
  readonly taskListId: string;
}> {}

/** A Reminders-only field (time, priority, url, alarms, recurrence, move) sent to a Google list. */
export class UnsupportedForProviderError extends Data.TaggedError('UnsupportedForProviderError')<{
  readonly field: string;
  readonly provider: TaskProvider;
}> {}

/**
 * updateTask changes: `undefined` leaves a field alone; `null` clears a
 * Reminders-only field; `moveToListId` moves a reminder to another list.
 */
export interface TaskWriteChanges {
  readonly alarms?: ReadonlyArray<number> | null | undefined;
  readonly dueDate?: string | undefined;
  readonly dueTime?: string | null | undefined;
  readonly moveToListId?: string | undefined;
  readonly notes?: string | undefined;
  readonly priority?: TaskPriority | null | undefined;
  readonly recurrence?: TaskRecurrence | null | undefined;
  readonly title?: string | undefined;
  readonly url?: string | null | undefined;
}

export type TaskProviderError = RemindersError | UnsupportedForProviderError;

/** Sentinel eventId keying calendar-color ops for coalescing. */
export const CALENDAR_COLOR_EVENT_ID = '__calendar_color__';

export interface UpdateEventParams {
  readonly accountId: string;
  readonly calendarId: string;
  readonly changes: {
    readonly description?: string | undefined;
    readonly endDate?: string | undefined;
    readonly endUtc?: number | undefined;
    readonly isAllDay?: boolean | undefined;
    readonly location?: string | undefined;
    readonly startDate?: string | undefined;
    readonly startUtc?: number | undefined;
    readonly title?: string | undefined;
  };
  readonly eventId: string;
}

/** Identifies one occurrence of a recurring series and the edit's reach. */
export interface RecurringTargetParams {
  readonly accountId: string;
  readonly calendarId: string;
  readonly masterId: string;
  readonly originalStartUtc: number;
  readonly scope: RecurringScope;
}

export interface UpdateRecurringParams extends RecurringTargetParams {
  readonly changes: UpdateEventParams['changes'];
}

type RecurringEditError = EventNotFoundError | RecurringEditUnsupportedError | SqlError;

export interface EventMutationsShape {
  /** Toggles a task's completion locally and writes it back (Google queue / EventKit). */
  readonly completeTask: (params: {
    readonly accountId: string;
    readonly status: TaskRecord['status'];
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<void, SqlError | TaskNotFoundError | TaskProviderError>;
  readonly createEvent: (draft: EventDraft) => Effect.Effect<EventRecord, SqlError>;
  /**
   * Google: optimistic temp-id row + queued insert (ids are server-assigned).
   * Apple: written to EventKit synchronously; the returned record is final.
   */
  readonly createTask: (params: {
    readonly accountId: string;
    readonly alarms?: ReadonlyArray<number> | undefined;
    readonly dueDate: string;
    readonly dueTime?: string | undefined;
    readonly notes?: string | undefined;
    readonly priority?: TaskPriority | undefined;
    readonly recurrence?: TaskRecurrence | undefined;
    readonly taskListId: string;
    readonly title: string;
    readonly url?: string | undefined;
  }) => Effect.Effect<TaskRecord, SqlError | TaskListNotFoundError | TaskProviderError>;
  readonly deleteEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly eventId: string;
  }) => Effect.Effect<void, RecurringEditError>;
  readonly deleteRecurring: (
    params: RecurringTargetParams,
  ) => Effect.Effect<void, RecurringEditError>;
  readonly deleteTask: (params: {
    readonly accountId: string;
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<void, SqlError | TaskProviderError>;
  /** Drains due pending ops (serialized); safe to call concurrently. */
  readonly processPendingOps: () => Effect.Effect<void>;
  /** Updates the caller's own attendee responseStatus (series-wide). */
  readonly respondToEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly eventId: string;
    readonly response: RsvpResponse;
  }) => Effect.Effect<void, EventNotFoundError | NotAttendeeError | SqlError>;
  /** Recolors a calendar locally and writes it back to Google. */
  readonly setCalendarColor: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly colorHex: string;
  }) => Effect.Effect<void, InvalidColorError | SqlError>;
  readonly updateEvent: (params: UpdateEventParams) => Effect.Effect<void, RecurringEditError>;
  readonly updateRecurring: (
    params: UpdateRecurringParams,
  ) => Effect.Effect<void, RecurringEditError>;
  /** Edits a task; Google gets title/notes/due, Reminders the full field set. */
  readonly updateTask: (params: {
    readonly accountId: string;
    readonly changes: TaskWriteChanges;
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<void, SqlError | TaskProviderError>;
}

/** Backoff for transient op failures: 30s · 2^attempts, capped at 30min. */
export const retryDelayMs = (attempts: number): number =>
  Math.min(30_000 * 2 ** attempts, 30 * 60 * 1000);
