import { Cause, Effect, Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import type { RpcClientError } from 'effect/unstable/rpc/RpcClientError';
import {
  Account,
  CalendarInfo,
  EventRecord,
  TaskListInfo,
  TaskRecord,
  TaskStatus,
} from './types.ts';

/**
 * The platform seam: every UI talks to the backend exclusively through this
 * Schema-typed rpc group. iOS wraps the handlers in-process (no serialization
 * hop); Electron serves it from the main process over an IPC transport.
 */

export const EventDraft = Schema.Struct({
  accountId: Schema.String,
  calendarId: Schema.String,
  description: Schema.optional(Schema.String),
  /** All-day drafts use dates; timed drafts use epochs + zone. */
  endDate: Schema.optional(Schema.String),
  endUtc: Schema.Number,
  isAllDay: Schema.Boolean,
  location: Schema.optional(Schema.String),
  /** RFC 5545 lines (RRULE/...) to create the event as a recurring master. */
  recurrence: Schema.optional(Schema.Array(Schema.String)),
  startDate: Schema.optional(Schema.String),
  startTimeZone: Schema.optional(Schema.String),
  startUtc: Schema.Number,
  title: Schema.String,
});
export type EventDraft = Schema.Schema.Type<typeof EventDraft>;

export const UpdateEventChanges = Schema.Struct({
  description: Schema.optional(Schema.String),
  endDate: Schema.optional(Schema.String),
  endUtc: Schema.optional(Schema.Number),
  isAllDay: Schema.optional(Schema.Boolean),
  location: Schema.optional(Schema.String),
  startDate: Schema.optional(Schema.String),
  startUtc: Schema.optional(Schema.Number),
  title: Schema.optional(Schema.String),
});

export const RecurringScope = Schema.Literals(['following', 'instance', 'series']);
export type RecurringScope = Schema.Schema.Type<typeof RecurringScope>;

export const RsvpResponse = Schema.Literals(['accepted', 'declined', 'tentative']);
export type RsvpResponse = Schema.Schema.Type<typeof RsvpResponse>;

/** Queue entry surfaced to the UI (payload stripped; title pulled out). */
export const PendingOpSummary = Schema.Struct({
  attempts: Schema.Number,
  calendarId: Schema.String,
  createdAt: Schema.Number,
  eventId: Schema.String,
  id: Schema.String,
  kind: Schema.Literals([
    'calendarColor',
    'completeTask',
    'create',
    'createTask',
    'delete',
    'deleteTask',
    'rsvp',
    'update',
    'updateTask',
  ]),
  lastError: Schema.optional(Schema.String),
  nextAttemptAt: Schema.Number,
  title: Schema.optional(Schema.String),
});
export type PendingOpSummary = Schema.Schema.Type<typeof PendingOpSummary>;

/** Wire format of a failed backend call. */
export class BackendError extends Schema.Error<BackendError>('core/BackendError')({
  message: Schema.String,
  tag: Schema.String,
}) {}

export class AppBackendRpcs extends RpcGroup.make(
  Rpc.make('addAccount', { error: BackendError, success: Account }),
  Rpc.make('completeTask', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      status: TaskStatus,
      taskId: Schema.String,
      taskListId: Schema.String,
    },
  }),
  Rpc.make('createEvent', {
    error: BackendError,
    payload: EventDraft,
    success: EventRecord,
  }),
  Rpc.make('createTask', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      dueDate: Schema.String,
      notes: Schema.optional(Schema.String),
      taskListId: Schema.String,
      title: Schema.String,
    },
    success: TaskRecord,
  }),
  Rpc.make('deleteEvent', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      calendarId: Schema.String,
      eventId: Schema.String,
    },
  }),
  Rpc.make('deleteTask', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      taskId: Schema.String,
      taskListId: Schema.String,
    },
  }),
  Rpc.make('discardPendingOp', {
    error: BackendError,
    payload: { opId: Schema.String },
  }),
  Rpc.make('deleteRecurring', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      calendarId: Schema.String,
      masterId: Schema.String,
      originalStartUtc: Schema.Number,
      scope: RecurringScope,
    },
  }),
  Rpc.make('getEventsInRange', {
    error: BackendError,
    payload: { rangeEndUtc: Schema.Number, rangeStartUtc: Schema.Number },
    success: Schema.Array(EventRecord),
  }),
  Rpc.make('getTasksInRange', {
    error: BackendError,
    /** Due-day window, inclusive 'YYYY-MM-DD' bounds (tasks are date-only). */
    payload: { endDate: Schema.String, startDate: Schema.String },
    success: Schema.Array(TaskRecord),
  }),
  Rpc.make('invalidations', {
    /** Server-push stream of invalidated Reactivity key batches. */
    stream: true,
    success: Schema.Array(Schema.String),
  }),
  Rpc.make('listTaskLists', {
    error: BackendError,
    success: Schema.Array(TaskListInfo),
  }),
  Rpc.make('listPendingOps', {
    error: BackendError,
    success: Schema.Array(PendingOpSummary),
  }),
  Rpc.make('listAccounts', {
    error: BackendError,
    success: Schema.Array(Account),
  }),
  Rpc.make('listCalendars', {
    error: BackendError,
    payload: { accountId: Schema.optional(Schema.String) },
    success: Schema.Array(CalendarInfo),
  }),
  Rpc.make('removeAccount', {
    error: BackendError,
    payload: { accountId: Schema.String },
  }),
  Rpc.make('respondToEvent', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      calendarId: Schema.String,
      eventId: Schema.String,
      response: RsvpResponse,
    },
  }),
  Rpc.make('setCalendarColor', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      calendarId: Schema.String,
      colorHex: Schema.String,
    },
  }),
  Rpc.make('setCalendarVisible', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      calendarId: Schema.String,
      isVisible: Schema.Boolean,
    },
  }),
  Rpc.make('setTaskListVisible', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      isVisible: Schema.Boolean,
      taskListId: Schema.String,
    },
  }),
  Rpc.make('syncNow', { error: BackendError }),
  Rpc.make('updateEvent', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      calendarId: Schema.String,
      changes: UpdateEventChanges,
      eventId: Schema.String,
    },
  }),
  Rpc.make('updateRecurring', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      calendarId: Schema.String,
      changes: UpdateEventChanges,
      masterId: Schema.String,
      originalStartUtc: Schema.Number,
      scope: RecurringScope,
    },
  }),
  Rpc.make('updateTask', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      changes: Schema.Struct({
        dueDate: Schema.optional(Schema.String),
        notes: Schema.optional(Schema.String),
        title: Schema.optional(Schema.String),
      }),
      taskId: Schema.String,
      taskListId: Schema.String,
    },
  }),
) {}

/**
 * Every request/response method tag, derived from the rpc group — adding an
 * Rpc.make above is the single edit; the stream rpc (`invalidations`) is
 * platform wiring, not a method.
 */
export type BackendMethodName = Exclude<
  RpcGroup.Rpcs<typeof AppBackendRpcs>['_tag'],
  'invalidations'
>;

/** The same list at runtime (drives the derived client/handler records). */
export const backendMethodNames: ReadonlyArray<BackendMethodName> = [
  ...AppBackendRpcs.requests.keys(),
].filter((tag): tag is BackendMethodName => tag !== 'invalidations');

/** Payload/success types per method, derived from the rpc group. */
type RpcByTag<Tag extends string> = Extract<
  RpcGroup.Rpcs<typeof AppBackendRpcs>,
  { readonly _tag: Tag }
>;
export type BackendPayload<Tag extends BackendMethodName> = Rpc.Payload<RpcByTag<Tag>>;
export type BackendSuccess<Tag extends BackendMethodName> = Rpc.Success<RpcByTag<Tag>>;

/**
 * The request/response surface the UI consumes (the invalidations stream is
 * platform wiring, not part of this shape). The Electron rpc client and the
 * iOS direct client both conform structurally.
 */
export type BackendClient = {
  readonly [M in BackendMethodName]: (
    payload: BackendPayload<M>,
  ) => Effect.Effect<BackendSuccess<M>, BackendError | RpcClientError>;
};

/**
 * Host-side handler map (request/response methods): platform-independent
 * implementations with arbitrary error types; `mapToBackendError` normalizes
 * them to the declared BackendError before they cross the rpc boundary.
 */
export type BackendHandlers<R = never> = {
  readonly [M in BackendMethodName]: (
    payload: BackendPayload<M>,
  ) => Effect.Effect<BackendSuccess<M>, unknown, R>;
};

/** Collapses any failure cause into the wire-format BackendError. */
export const mapToBackendError = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, BackendError, R> =>
  Effect.catchCause(effect, (cause) => {
    const failure = cause.reasons.find((reason) => Cause.isFailReason(reason));
    const error = failure?.error;
    if (error instanceof BackendError) {
      return Effect.fail(error);
    }
    const tag =
      typeof error === 'object' && error !== null && '_tag' in error
        ? String((error as { _tag: unknown })._tag)
        : 'UnknownError';
    return Effect.fail(new BackendError({ message: String(error ?? cause), tag }));
  });

/**
 * In-process client: wraps handlers directly (no serialization hop) — used on
 * iOS where the backend runs inside the app.
 */
export const makeDirectBackendClient = <R>(
  handlers: BackendHandlers<R>,
  run: <A>(effect: Effect.Effect<A, BackendError, R>) => Promise<A>,
): BackendClient => {
  const method = <M extends BackendMethodName>(name: M) => {
    return (payload: BackendPayload<M>): Effect.Effect<BackendSuccess<M>, BackendError> =>
      Effect.tryPromise({
        catch: (error) =>
          error instanceof BackendError
            ? error
            : new BackendError({ message: String(error), tag: 'UnknownError' }),
        try: () =>
          run(mapToBackendError(handlers[name](payload as never))) as Promise<BackendSuccess<M>>,
      });
  };
  // Derived record: per-method types are guaranteed by `method` itself; the
  // cast only reassembles them into the mapped BackendClient shape.
  return Object.fromEntries(
    backendMethodNames.map((name) => [name, method(name)]),
  ) as BackendClient;
};
