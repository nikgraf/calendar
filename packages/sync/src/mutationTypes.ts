import type {
  EventDraft,
  EventRecord,
  RecurringScope,
  RsvpResponse,
  TaskRecord,
} from '@calendar/core';
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
  /** Toggles a task's completion locally and writes it back to Google. */
  readonly completeTask: (params: {
    readonly accountId: string;
    readonly status: TaskRecord['status'];
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<void, SqlError | TaskNotFoundError>;
  readonly createEvent: (draft: EventDraft) => Effect.Effect<EventRecord, SqlError>;
  /** Creates a task optimistically under a temp id; the push swaps ids. */
  readonly createTask: (params: {
    readonly accountId: string;
    readonly dueDate: string;
    readonly notes?: string | undefined;
    readonly taskListId: string;
    readonly title: string;
  }) => Effect.Effect<TaskRecord, SqlError | TaskListNotFoundError>;
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
  }) => Effect.Effect<void, SqlError>;
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
  /** Edits title/notes/due optimistically and patches Google. */
  readonly updateTask: (params: {
    readonly accountId: string;
    readonly changes: {
      readonly dueDate?: string | undefined;
      readonly notes?: string | undefined;
      readonly title?: string | undefined;
    };
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<void, SqlError>;
}

/** Backoff for transient op failures: 30s · 2^attempts, capped at 30min. */
export const retryDelayMs = (attempts: number): number =>
  Math.min(30_000 * 2 ** attempts, 30 * 60 * 1000);
