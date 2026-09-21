import type {
  AttendeeInput,
  EventDraft,
  EventRecord,
  GeoLocation,
  RecurringScope,
  RsvpResponse,
  TaskPriority,
  TaskProvider,
  TaskRecord,
  TaskRecurrence,
} from '@calendar/core';
import type { AppleCalendarError } from '@calendar/apple-calendar';
import type { MoveEventParams, MoveLoss, MoveTaskParams } from '@calendar/core';
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

/**
 * A field the target provider cannot store: a Reminders-only task field
 * sent to a Google list, or on an Apple calendar event guests, an RSVP or
 * a repeat rule EventKit cannot express (`field` names it).
 */
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

/** Failures only an Apple Calendar (EventKit) event write can produce. */
export type EventProviderError = AppleCalendarError | UnsupportedForProviderError;

/** Moving needs the organizer: an invitation cannot be re-homed by a guest. */
export class NotOrganizerError extends Data.TaggedError('NotOrganizerError')<{
  readonly eventId: string;
}> {}

/** The move target is unknown or read-only. */
export class CalendarNotWritableError extends Data.TaggedError('CalendarNotWritableError')<{
  readonly calendarId: string;
}> {}

type MoveError =
  | CalendarNotWritableError
  | EventNotFoundError
  | EventProviderError
  | NotOrganizerError
  | RecurringEditUnsupportedError
  | SqlError;

/** Sentinel eventId keying calendar-color ops for coalescing. */
export const CALENDAR_COLOR_EVENT_ID = '__calendar_color__';

export interface UpdateEventParams {
  readonly accountId: string;
  readonly calendarId: string;
  readonly changes: {
    /** Full replacement guest list: undefined leaves it alone, [] removes everyone. */
    readonly attendees?: ReadonlyArray<AttendeeInput> | undefined;
    readonly description?: string | undefined;
    readonly endDate?: string | undefined;
    readonly endUtc?: number | undefined;
    /** Coordinates for the location: null clears, undefined leaves them alone. */
    readonly geo?: GeoLocation | null | undefined;
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

type RecurringEditError =
  | EventNotFoundError
  | EventProviderError
  | RecurringEditUnsupportedError
  | SqlError;

export interface EventMutationsShape {
  /** Toggles a task's completion locally and writes it back (Google queue / EventKit). */
  readonly completeTask: (params: {
    readonly accountId: string;
    readonly status: TaskRecord['status'];
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<void, SqlError | TaskNotFoundError | TaskProviderError>;
  readonly createEvent: (
    draft: EventDraft,
  ) => Effect.Effect<EventRecord, EventProviderError | SqlError>;
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
  /**
   * Moves an event (the whole series for a recurring one) to another
   * calendar: a server move inside one Google account, EventKit's own
   * calendar change between Apple calendars, otherwise a copy into the
   * target followed by a delete of the source.
   */
  readonly moveEvent: (params: MoveEventParams) => Effect.Effect<void, MoveError>;
  /**
   * Moves a task to another list: EventKit's own list change between
   * Reminders lists (identity kept), otherwise a create in the target
   * from `draft` followed by a delete of the source. Completion follows
   * the task. Returns the record now in the target list.
   */
  readonly moveTask: (
    params: MoveTaskParams,
  ) => Effect.Effect<
    TaskRecord,
    SqlError | TaskListNotFoundError | TaskNotFoundError | TaskProviderError
  >;
  /** What moveEvent with these params would drop (see core moveLoss). */
  readonly previewMove: (params: MoveEventParams) => Effect.Effect<MoveLoss, MoveError>;
  /** Drains due pending ops (serialized); safe to call concurrently. */
  readonly processPendingOps: () => Effect.Effect<void>;
  /** Updates the caller's own attendee responseStatus (series-wide). */
  readonly respondToEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly eventId: string;
    readonly response: RsvpResponse;
  }) => Effect.Effect<void, EventNotFoundError | EventProviderError | NotAttendeeError | SqlError>;
  /** Recolors a calendar locally and writes it back to Google. */
  readonly setCalendarColor: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly colorHex: string;
  }) => Effect.Effect<void, EventProviderError | InvalidColorError | SqlError>;
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
