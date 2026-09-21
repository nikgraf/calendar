import { Cause, Effect, Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import type { RpcClientError } from 'effect/unstable/rpc/RpcClientError';
import { BirthdayReminderSettings } from './birthdays/reminders.ts';
import { MoveLoss } from './editor/moveLoss.ts';
import { PlaceSuggestion } from './geo/location.ts';
import { AccountSyncStatus } from './syncStatus.ts';
import {
  Account,
  BirthdayOccurrence,
  CalendarInfo,
  Contact,
  EventRecord,
  GeoLocation,
  TaskListInfo,
  TaskPriority,
  TaskRecord,
  TaskRecurrence,
  TaskStatus,
} from './types.ts';
import { ViewPreferences } from './viewPreferences.ts';

/**
 * The platform seam: every UI talks to the backend exclusively through this
 * Schema-typed rpc group. iOS wraps the handlers in-process (no serialization
 * hop); Electron serves it from the main process over an IPC transport.
 */

/** A guest as the editor names them; response status is Google's to assign. */
export const AttendeeInput = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  email: Schema.String,
});
export type AttendeeInput = Schema.Schema.Type<typeof AttendeeInput>;

export const EventDraft = Schema.Struct({
  accountId: Schema.String,
  /** Guests to invite; the organizer is added by Google on insert. */
  attendees: Schema.optional(Schema.Array(AttendeeInput)),
  calendarId: Schema.String,
  description: Schema.optional(Schema.String),
  /** All-day drafts use dates; timed drafts use epochs + zone. */
  endDate: Schema.optional(Schema.String),
  endUtc: Schema.Number,
  /** Coordinates for `location` (from the place picker); dropped unless they match it. */
  geo: Schema.optional(GeoLocation),
  isAllDay: Schema.Boolean,
  location: Schema.optional(Schema.String),
  /** RFC 5545 lines (RRULE/...) to create the event as a recurring master. */
  recurrence: Schema.optional(Schema.Array(Schema.String)),
  startDate: Schema.optional(Schema.String),
  startTimeZone: Schema.optional(Schema.String),
  startUtc: Schema.Number,
  title: Schema.String,
  /**
   * Apple calendars only: the event's URL (a Google→Apple move carries the
   * meeting link here). Google creates ignore it.
   */
  url: Schema.optional(Schema.String),
});
export type EventDraft = Schema.Schema.Type<typeof EventDraft>;

export const UpdateEventChanges = Schema.Struct({
  /** Full replacement guest list: undefined leaves it alone, [] removes everyone. */
  attendees: Schema.optional(Schema.Array(AttendeeInput)),
  description: Schema.optional(Schema.String),
  endDate: Schema.optional(Schema.String),
  endUtc: Schema.optional(Schema.Number),
  /** Coordinates for the (new) location: null clears, undefined leaves them alone. */
  geo: Schema.optional(Schema.NullOr(GeoLocation)),
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
    'move',
    'rsvp',
    'update',
    'updateTask',
  ]),
  lastError: Schema.optional(Schema.String),
  nextAttemptAt: Schema.Number,
  title: Schema.optional(Schema.String),
});
export type PendingOpSummary = Schema.Schema.Type<typeof PendingOpSummary>;

/** Source event (the master id for a series) and the calendar it moves to. */
export const MoveEventParams = Schema.Struct({
  accountId: Schema.String,
  calendarId: Schema.String,
  eventId: Schema.String,
  target: Schema.Struct({ accountId: Schema.String, calendarId: Schema.String }),
});
export type MoveEventParams = Schema.Schema.Type<typeof MoveEventParams>;

/** A task as the editor submits it; the fields after `dueDate` are Reminders-only. */
export const TaskDraft = Schema.Struct({
  alarms: Schema.optional(Schema.Array(Schema.Number)),
  dueDate: Schema.String,
  dueTime: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String),
  priority: Schema.optional(TaskPriority),
  recurrence: Schema.optional(TaskRecurrence),
  title: Schema.String,
  url: Schema.optional(Schema.String),
});
export type TaskDraft = Schema.Schema.Type<typeof TaskDraft>;

/**
 * Source task and the list it moves to. `draft` is what the target
 * provider's form holds on Save: unlike an event move, the copy is
 * written from it rather than from the source row, so a Google task can
 * pick up a due time or priority on its way into Reminders.
 */
export const MoveTaskParams = Schema.Struct({
  accountId: Schema.String,
  draft: TaskDraft,
  target: Schema.Struct({ accountId: Schema.String, taskListId: Schema.String }),
  taskId: Schema.String,
  taskListId: Schema.String,
});
export type MoveTaskParams = Schema.Schema.Type<typeof MoveTaskParams>;

/** Wire format of a failed backend call. */
export class BackendError extends Schema.Error<BackendError>('core/BackendError')({
  message: Schema.String,
  tag: Schema.String,
}) {}

export class AppBackendRpcs extends RpcGroup.make(
  Rpc.make('addAccount', { error: BackendError, success: Account }),
  /** Wipes the on-device location geocode cache (Settings). */
  Rpc.make('clearLocationCache', { error: BackendError }),
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
  /** Device contacts: asks for Contacts access (the OS prompt when undetermined). */
  Rpc.make('connectContacts', {
    error: BackendError,
    success: Schema.Struct({ granted: Schema.Boolean }),
  }),
  /** Apple Calendar: asks for EventKit events access; on grant, the synthetic account exists afterwards. */
  Rpc.make('connectAppleCalendar', {
    error: BackendError,
    success: Schema.Struct({ granted: Schema.Boolean }),
  }),
  /** Apple Reminders: asks for EventKit access; on grant, the synthetic account exists afterwards. */
  Rpc.make('connectReminders', {
    error: BackendError,
    success: Schema.Struct({ granted: Schema.Boolean }),
  }),
  Rpc.make('createTask', {
    error: BackendError,
    payload: {
      accountId: Schema.String,
      // The fields after `dueDate` are Reminders-only; Google lists reject them.
      alarms: Schema.optional(Schema.Array(Schema.Number)),
      dueDate: Schema.String,
      dueTime: Schema.optional(Schema.String),
      notes: Schema.optional(Schema.String),
      priority: Schema.optional(TaskPriority),
      recurrence: Schema.optional(TaskRecurrence),
      taskListId: Schema.String,
      title: Schema.String,
      url: Schema.optional(Schema.String),
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
  /** Device-local birthday reminder preferences (never synced). */
  Rpc.make('getBirthdayReminderSettings', {
    error: BackendError,
    success: BirthdayReminderSettings,
  }),
  /** Contact birthdays (Google People + device) falling on days in the window, inclusive bounds. */
  Rpc.make('getBirthdaysInRange', {
    error: BackendError,
    payload: { endDate: Schema.String, startDate: Schema.String },
    success: Schema.Array(BirthdayOccurrence),
  }),
  Rpc.make('getEventsInRange', {
    error: BackendError,
    payload: { rangeEndUtc: Schema.Number, rangeStartUtc: Schema.Number },
    success: Schema.Array(EventRecord),
  }),
  Rpc.make('getOverdueTasks', {
    error: BackendError,
    /** Open tasks due strictly before `before` ('YYYY-MM-DD'), visible lists only; drawn on today. */
    payload: { before: Schema.String },
    success: Schema.Array(TaskRecord),
  }),
  Rpc.make('getTasksInRange', {
    error: BackendError,
    /** Due-day window, inclusive 'YYYY-MM-DD' bounds (tasks are date-only). */
    payload: { endDate: Schema.String, startDate: Schema.String },
    success: Schema.Array(TaskRecord),
  }),
  /** Device-local view preferences (never synced). */
  Rpc.make('getViewPreferences', {
    error: BackendError,
    success: ViewPreferences,
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
  /** Events history import progress per account, for the Settings line. */
  Rpc.make('listSyncStatus', {
    error: BackendError,
    success: Schema.Array(AccountSyncStatus),
  }),
  /**
   * Static map image for the event editor (desktop: MKMapSnapshotter in
   * the Swift helper). Fails where the platform renders a live map instead.
   */
  Rpc.make('mapSnapshot', {
    error: BackendError,
    payload: {
      appearance: Schema.Literals(['dark', 'light']),
      height: Schema.Number,
      lat: Schema.Number,
      lng: Schema.Number,
      scale: Schema.Number,
      width: Schema.Number,
    },
    success: Schema.Struct({ pngBase64: Schema.String }),
  }),
  /**
   * Moves an event (a whole series: pass the master id) to another
   * calendar, possibly in another account or provider. Inside one Google
   * account this is a server move; anything else copies the event into
   * the target and deletes the source — call `previewMove` first and
   * confirm what that drops.
   */
  Rpc.make('moveEvent', {
    error: BackendError,
    payload: MoveEventParams,
  }),
  /**
   * Moves a task to another list, account or provider. Apple → Apple is
   * EventKit's own list change (same identifier); every other route
   * creates the task in the target from `draft` and deletes the source —
   * check `taskMoveLoss` first and confirm what that drops.
   */
  Rpc.make('moveTask', {
    error: BackendError,
    payload: MoveTaskParams,
    success: TaskRecord,
  }),
  /** What `moveEvent` with the same payload would drop (guests, link, modified occurrences…). */
  Rpc.make('previewMove', {
    error: BackendError,
    payload: MoveEventParams,
    success: MoveLoss,
  }),
  Rpc.make('removeAccount', {
    error: BackendError,
    payload: { accountId: Schema.String },
  }),
  /**
   * Coordinates for a location string, on-device and cached per string.
   * `suggestion` is the typeahead row the user picked (resolves exactly);
   * null when the text is not a place or nothing was found.
   */
  Rpc.make('resolveLocation', {
    error: BackendError,
    payload: { location: Schema.String, suggestion: Schema.optional(PlaceSuggestion) },
    success: Schema.NullOr(GeoLocation),
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
  /** Invitee typeahead: device + cached Google contacts, ranked, deduped by email. */
  Rpc.make('searchContacts', {
    error: BackendError,
    payload: { limit: Schema.optional(Schema.Number), query: Schema.String },
    success: Schema.Array(Contact),
  }),
  /** Location typeahead (MapKit completer); empty where there is no bridge. */
  Rpc.make('searchPlaces', {
    error: BackendError,
    payload: { limit: Schema.optional(Schema.Number), query: Schema.String },
    success: Schema.Array(PlaceSuggestion),
  }),
  /**
   * Saves the device-local reminder preferences. `notificationsGranted`
   * is false when enabling asked the OS for notification permission and
   * the user declined — the settings are saved either way.
   */
  Rpc.make('setBirthdayReminderSettings', {
    error: BackendError,
    payload: BirthdayReminderSettings,
    success: Schema.Struct({ notificationsGranted: Schema.Boolean }),
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
  Rpc.make('setViewPreferences', {
    error: BackendError,
    payload: ViewPreferences,
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
      // Reminders-only fields use null to clear; `moveToListId` moves the
      // reminder to another list (Google lists are fixed after create).
      changes: Schema.Struct({
        alarms: Schema.optional(Schema.NullOr(Schema.Array(Schema.Number))),
        dueDate: Schema.optional(Schema.String),
        dueTime: Schema.optional(Schema.NullOr(Schema.String)),
        moveToListId: Schema.optional(Schema.String),
        notes: Schema.optional(Schema.String),
        priority: Schema.optional(Schema.NullOr(TaskPriority)),
        recurrence: Schema.optional(Schema.NullOr(TaskRecurrence)),
        title: Schema.optional(Schema.String),
        url: Schema.optional(Schema.NullOr(Schema.String)),
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
