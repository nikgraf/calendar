import { Cause, Effect, Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import {
  BirthdayLeadDays,
  BirthdayReminderOverrides,
  BirthdayReminderSettings,
} from './birthdays/reminders.ts';
import { EventToTaskPreview } from './editor/convertLoss.ts';
import { MoveLoss } from './editor/moveLoss.ts';
import { PlaceSuggestion } from './geo/location.ts';
import { MirrorCalendarRef, MirrorDefinition } from './mirror/definition.ts';
import { MirrorPreview, MirrorView } from './mirror/status.ts';
import { EventNotificationSettings } from './notifications/settings.ts';
import { SettingsDocument, SettingsImportSummary } from './settingsDocument.ts';
import { AccountSyncStatus } from './syncStatus.ts';
import {
  Account,
  BirthdayOccurrence,
  CalendarInfo,
  Contact,
  EventRecord,
  EventReminders,
  GeoLocation,
  TaskListInfo,
  TaskPriority,
  TaskRecord,
  TaskRecurrence,
  TaskStatus,
} from './types.ts';
import { TimeZoneSettings } from './timeZoneSettings.ts';
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
  /** Absent = the calendar's default (Google) / no alarms (Apple). */
  reminders: Schema.optional(EventReminders),
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
  /**
   * Full replacement: undefined leaves the reminders alone. There is no
   * "clear" — `{ useDefault: true, overrides: [] }` is the Google reset and
   * `{ useDefault: false, overrides: [] }` means none.
   */
  reminders: Schema.optional(EventReminders),
  startDate: Schema.optional(Schema.String),
  startUtc: Schema.optional(Schema.Number),
  title: Schema.optional(Schema.String),
});

export const RecurringScope = Schema.Literals(['following', 'instance', 'series']);
export type RecurringScope = Schema.Schema.Type<typeof RecurringScope>;

export const ConflictChoice = Schema.Literals(['mine', 'theirs']);
export type ConflictChoice = Schema.Schema.Type<typeof ConflictChoice>;

export const RsvpResponse = Schema.Literals(['accepted', 'declined', 'tentative']);
export type RsvpResponse = Schema.Schema.Type<typeof RsvpResponse>;

/**
 * A parked 412: `mine` is the queued version (the deleted row for a
 * delete), `theirs` Google's version when the op was parked (null =
 * deleted on Google).
 */
export const PendingOpConflict = Schema.Struct({
  at: Schema.Number,
  mine: Schema.optional(EventRecord),
  theirs: Schema.NullOr(EventRecord),
});
export type PendingOpConflict = Schema.Schema.Type<typeof PendingOpConflict>;

/** Queue entry surfaced to the UI (payload stripped; title pulled out). */
export const PendingOpSummary = Schema.Struct({
  /** Whose queue it is: removing that account drops the change. */
  accountId: Schema.String,
  attempts: Schema.Number,
  calendarId: Schema.String,
  /** Set while a 412 has the op parked, waiting for keep-mine / take-theirs. */
  conflict: Schema.optional(PendingOpConflict),
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

/**
 * Source event (the master id for a series) and the list the task it
 * becomes goes to. `draft` is what the task form holds on Save: like a
 * task move, the copy is written from it, not from the event row.
 */
export const ConvertEventToTaskParams = Schema.Struct({
  accountId: Schema.String,
  calendarId: Schema.String,
  draft: TaskDraft,
  eventId: Schema.String,
  target: Schema.Struct({ accountId: Schema.String, taskListId: Schema.String }),
});
export type ConvertEventToTaskParams = Schema.Schema.Type<typeof ConvertEventToTaskParams>;

/** `ConvertEventToTaskParams` without the draft: what the preview needs. */
export const PreviewEventToTaskParams = Schema.Struct({
  accountId: Schema.String,
  calendarId: Schema.String,
  eventId: Schema.String,
  target: Schema.Struct({ accountId: Schema.String, taskListId: Schema.String }),
});
export type PreviewEventToTaskParams = Schema.Schema.Type<typeof PreviewEventToTaskParams>;

/** Source task and the event it becomes (`draft` names the target calendar). */
export const ConvertTaskToEventParams = Schema.Struct({
  accountId: Schema.String,
  draft: EventDraft,
  taskId: Schema.String,
  taskListId: Schema.String,
});
export type ConvertTaskToEventParams = Schema.Schema.Type<typeof ConvertTaskToEventParams>;

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
  /**
   * A new calendar for a mirror to copy into: in a Google account (needs
   * the calendar-creation scope — an account signed in before the app asked
   * for it fails with tag 'needsSignIn') or in the device's default Apple
   * account. Resolves to the ref a definition names it by.
   */
  Rpc.make('createMirrorCalendar', {
    error: BackendError,
    payload: {
      target: Schema.Union([
        Schema.Struct({
          accountId: Schema.String,
          kind: Schema.Literal('google'),
          title: Schema.String,
        }),
        Schema.Struct({ kind: Schema.Literal('apple'), title: Schema.String }),
      ]),
    },
    success: MirrorCalendarRef,
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
  /**
   * Turns an event (a whole series: pass the master id) into a task in
   * the given list: the task is created from `draft`, then the event is
   * deleted — call `previewEventToTask` first and confirm what that drops.
   */
  Rpc.make('convertEventToTask', {
    error: BackendError,
    payload: ConvertEventToTaskParams,
    success: TaskRecord,
  }),
  /**
   * Turns a task into an event: the event is created from `draft`, then
   * the task is deleted — check `taskToEventLoss` first and confirm what
   * that drops.
   */
  Rpc.make('convertTaskToEvent', {
    error: BackendError,
    payload: ConvertTaskToEventParams,
    success: EventRecord,
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
  /**
   * The portable settings document (device settings, desktop-only settings,
   * accounts as a sign-in checklist with calendar/list visibility). Never
   * contains tokens.
   */
  Rpc.make('exportSettings', {
    error: BackendError,
    success: SettingsDocument,
  }),
  /** Forgets a mirror here; with `removeCopies` its copies leave the destination first. */
  Rpc.make('deleteMirror', {
    error: BackendError,
    payload: { id: Schema.String, removeCopies: Schema.Boolean },
  }),
  /** People with their own birthday lead days, in merge-key order. */
  Rpc.make('getBirthdayReminderOverrides', {
    error: BackendError,
    success: BirthdayReminderOverrides,
  }),
  /** Device-local birthday reminder preferences (never synced). */
  Rpc.make('getBirthdayReminderSettings', {
    error: BackendError,
    success: BirthdayReminderSettings,
  }),
  /** Device-local event notification preferences (never synced). */
  Rpc.make('getEventNotificationSettings', {
    error: BackendError,
    success: EventNotificationSettings,
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
    /**
     * What the calendar draws inside an inclusive 'YYYY-MM-DD' window:
     * tasks due in it, every open undated task (drawn on today) and tasks
     * completed around it (a late or undated completion sits on its
     * completion day). May repeat a task; place with `taskCalendarDate`.
     */
    payload: { endDate: Schema.String, startDate: Schema.String },
    success: Schema.Array(TaskRecord),
  }),
  /** Device-local time zones: 1–3 IANA ids, one primary (never synced). */
  Rpc.make('getTimeZoneSettings', {
    error: BackendError,
    success: TimeZoneSettings,
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
  /**
   * Applies a settings document: sections present are written, a Google
   * account unknown here is created as "Sign in again" (no token), Apple
   * accounts are never connected by an import, and visibility for rows not
   * synced yet waits for their sync. Never removes anything.
   */
  Rpc.make('importSettings', {
    error: BackendError,
    payload: { document: SettingsDocument },
    success: SettingsImportSummary,
  }),
  /** Every mirror with its state on this device. */
  Rpc.make('listMirrors', {
    error: BackendError,
    success: Schema.Array(MirrorView),
  }),
  /** What `convertEventToTask` with the same source and target would drop (guests, location, time…). */
  Rpc.make('previewEventToTask', {
    error: BackendError,
    payload: PreviewEventToTaskParams,
    success: EventToTaskPreview,
  }),
  /** What `importSettings` with the same document would do, without doing it. */
  Rpc.make('previewSettingsImport', {
    error: BackendError,
    payload: { document: SettingsDocument },
    success: SettingsImportSummary,
  }),
  /** What a mirror definition would write, before it is saved. Reads only. */
  Rpc.make('previewMirror', {
    error: BackendError,
    payload: { definition: MirrorDefinition },
    success: MirrorPreview,
  }),
  /** One pass over every mirror now, skipping the large-removal wait. */
  Rpc.make('runMirrorsNow', { error: BackendError }),
  /** Adds or replaces a mirror; a new one is switched on here. The error names a collision. */
  Rpc.make('saveMirror', {
    error: BackendError,
    payload: { definition: MirrorDefinition },
    success: MirrorView,
  }),
  /** Switches a mirror on or off on this device. */
  Rpc.make('setMirrorEnabled', {
    error: BackendError,
    payload: { enabled: Schema.Boolean, id: Schema.String },
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
   * Settles a parked 412: 'mine' re-sends the queued change without
   * If-Match (overwriting Google), 'theirs' replaces the local copy with
   * Google's current version and drops the change. A no-op for an op that
   * is gone or no longer parked.
   */
  Rpc.make('resolveConflict', {
    error: BackendError,
    payload: { choice: ConflictChoice, opId: Schema.String },
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
   * Gives one person their own lead days (`[]`: no reminder for them), or
   * with `leadDays: null` returns them to the general ones. Never asks for
   * permission — the general switch did, and an override cannot turn the
   * reminders on.
   */
  Rpc.make('setBirthdayReminderOverride', {
    error: BackendError,
    payload: {
      day: Schema.Number,
      displayName: Schema.String,
      leadDays: Schema.NullOr(Schema.Array(BirthdayLeadDays)),
      month: Schema.Number,
    },
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
  /** Same contract as setBirthdayReminderSettings, for event notifications. */
  Rpc.make('setEventNotificationSettings', {
    error: BackendError,
    payload: EventNotificationSettings,
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
  Rpc.make('setTimeZoneSettings', {
    error: BackendError,
    payload: TimeZoneSettings,
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
