import { Schema } from 'effect';

export const AccountStatus = Schema.Literals(['ok', 'reauth_required']);
export const AccessRole = Schema.Literals(['freeBusyReader', 'owner', 'reader', 'writer']);
export const EventStatus = Schema.Literals(['cancelled', 'confirmed', 'tentative']);
export const SyncStatus = Schema.Literals(['error', 'pending', 'synced']);
export const ResponseStatus = Schema.Literals(['accepted', 'declined', 'needsAction', 'tentative']);
export const TaskStatus = Schema.Literals(['completed', 'needsAction']);
/** Which system a task list (and its tasks) lives in. */
export const TaskProvider = Schema.Literals(['apple', 'google']);
export type TaskProvider = typeof TaskProvider.Type;
/** Reminders priority buckets (EventKit's 0…9 collapses to these). */
export const TaskPriority = Schema.Literals(['high', 'low', 'medium']);
export type TaskPriority = typeof TaskPriority.Type;
/** The recurrence subset a Reminders rule round-trips through (see RecurrenceRuleSpec). */
export const TaskRecurrence = Schema.Struct({
  count: Schema.optional(Schema.Number),
  freq: Schema.Literals(['daily', 'monthly', 'weekly', 'yearly']),
  interval: Schema.Number,
  untilDate: Schema.optional(Schema.String),
});
export type TaskRecurrence = typeof TaskRecurrence.Type;
/** The one synthetic account that owns Apple Reminders lists on a device. */
export const APPLE_REMINDERS_ACCOUNT_ID = 'apple-reminders';

export class Account extends Schema.Class<Account>('Account')({
  avatarUrl: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  displayName: Schema.optional(Schema.String),
  email: Schema.String,
  /** Stable local UUID — never the Google account id. */
  id: Schema.String,
  /** 'google' accounts sign in via OAuth; the single 'apple' account is the device's Reminders. */
  provider: TaskProvider,
  status: AccountStatus,
  /**
   * Whether this account's token was granted the Google Tasks scope.
   * Derived from TokenSet.scopes at sign-in; false for accounts connected
   * before the scope existed — re-running "Add Google Account" upgrades
   * them in place.
   */
  tasksEnabled: Schema.Boolean,
}) {}

/** Lives ONLY in the platform TokenStore (Keychain/safeStorage), never in SQLite. */
export class TokenSet extends Schema.Class<TokenSet>('TokenSet')({
  accessToken: Schema.String,
  /** Epoch ms after which accessToken is considered expired. */
  expiresAt: Schema.Number,
  refreshToken: Schema.String,
  scopes: Schema.Array(Schema.String),
}) {}

export class CalendarInfo extends Schema.Class<CalendarInfo>('CalendarInfo')({
  accessRole: AccessRole,
  accountId: Schema.String,
  colorHex: Schema.String,
  /** Google calendar id, unique within an account (not across accounts). */
  id: Schema.String,
  isPrimary: Schema.Boolean,
  /** Local show/hide toggle — not synced to Google. */
  isVisible: Schema.Boolean,
  summary: Schema.String,
  timeZone: Schema.String,
}) {}

export class TaskListInfo extends Schema.Class<TaskListInfo>('TaskListInfo')({
  accountId: Schema.String,
  /** Reminders lists carry a color; Google lists do not. */
  colorHex: Schema.optional(Schema.String),
  /** Task-list id, unique within an account (Google id / EK calendar identifier). */
  id: Schema.String,
  /** Local show/hide toggle — not synced. */
  isVisible: Schema.Boolean,
  provider: TaskProvider,
  title: Schema.String,
}) {}

export class TaskRecord extends Schema.Class<TaskRecord>('TaskRecord')({
  accountId: Schema.String,
  /** Reminders only: alarm offsets in minutes relative to the due time (≤ 0 = before/at). */
  alarms: Schema.optional(Schema.Array(Schema.Number)),
  /** Epoch ms of completion; absent while the task is open. */
  completedAt: Schema.optional(Schema.Number),
  /**
   * Due day as 'YYYY-MM-DD'. Google Tasks are date-only by construction;
   * Reminders may add `dueTime`. Absent for undated tasks.
   */
  dueDate: Schema.optional(Schema.String),
  /** Reminders only: 'HH:MM' in the device zone when the reminder is timed. */
  dueTime: Schema.optional(Schema.String),
  /** Task id, unique within its list. */
  id: Schema.String,
  listId: Schema.String,
  notes: Schema.optional(Schema.String),
  /** Reminders only; absent = no priority. */
  priority: Schema.optional(TaskPriority),
  provider: TaskProvider,
  /** Reminders only: the editable repeat rule, when expressible. */
  recurrence: Schema.optional(TaskRecurrence),
  /** Reminders only: a repeat rule exists that the app cannot express (by-day, positional…) — never overwritten. */
  recurrenceUnsupported: Schema.optional(Schema.Literal(true)),
  status: TaskStatus,
  title: Schema.String,
  updatedAt: Schema.Number,
  /** Reminders only. */
  url: Schema.optional(Schema.String),
  webViewLink: Schema.optional(Schema.String),
}) {}

export class Attendee extends Schema.Class<Attendee>('Attendee')({
  displayName: Schema.optional(Schema.String),
  email: Schema.String,
  isOrganizer: Schema.optional(Schema.Boolean),
  isSelf: Schema.optional(Schema.Boolean),
  responseStatus: ResponseStatus,
}) {}

export class EventRecord extends Schema.Class<EventRecord>('EventRecord')({
  accountId: Schema.String,
  attendees: Schema.optional(Schema.Array(Attendee)),
  calendarId: Schema.String,
  description: Schema.optional(Schema.String),
  /** All-day end, exclusive, 'YYYY-MM-DD' — never derived via UTC conversion. */
  endDate: Schema.optional(Schema.String),
  endUtc: Schema.Number,
  etag: Schema.NullOr(Schema.String),
  /** Video-call link from Google's conferenceData/hangoutLink. */
  hangoutLink: Schema.optional(Schema.String),
  /** Google event id (base32hex; client-generated for local creates). */
  id: Schema.String,
  isAllDay: Schema.Boolean,
  location: Schema.optional(Schema.String),
  organizerEmail: Schema.optional(Schema.String),
  /** Identifies an override's slot in its series (from originalStartTime). */
  originalStartUtc: Schema.optional(Schema.Number),
  /** Raw RFC 5545 lines (RRULE/EXRULE/RDATE/EXDATE) — set only on masters. */
  recurrence: Schema.optional(Schema.Array(Schema.String)),
  /** Set only on override instances: id of the recurring master. */
  recurringEventId: Schema.optional(Schema.String),
  startDate: Schema.optional(Schema.String),
  /** IANA zone; drives recurrence expansion and cross-DST rendering. */
  startTimeZone: Schema.optional(Schema.String),
  startUtc: Schema.Number,
  status: EventStatus,
  syncedAt: Schema.Number,
  syncStatus: SyncStatus,
  title: Schema.String,
  updatedAt: Schema.Number,
}) {}

export class PendingOp extends Schema.Class<PendingOp>('PendingOp')({
  accountId: Schema.String,
  attempts: Schema.Number,
  /** If-Match etag captured when the op was enqueued (update/delete). */
  baseEtag: Schema.optional(Schema.String),
  calendarId: Schema.String,
  /** New calendar color for kind 'calendarColor' (lowercase #rrggbb). */
  colorHex: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  /**
   * Set just before a non-idempotent network call (createTask). A re-run
   * that finds it set must verify with the server before inserting again
   * — the first request may have landed even though we never saw the
   * response.
   */
  dispatchedAt: Schema.optional(Schema.Number),
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
  /** Snapshot of the event to send (create/update). */
  payload: Schema.optional(EventRecord),
  /** Due day (YYYY-MM-DD) for kind 'createTask'/'updateTask'. */
  taskDue: Schema.optional(Schema.String),
  /** Task-list id for the task op kinds (eventId carries the task id). */
  taskListId: Schema.optional(Schema.String),
  /** Notes for kind 'createTask'/'updateTask'. */
  taskNotes: Schema.optional(Schema.String),
  /** Desired task status for kind 'completeTask'. */
  taskStatus: Schema.optional(TaskStatus),
  /** Title for kind 'createTask'/'updateTask'. */
  taskTitle: Schema.optional(Schema.String),
}) {}

export class SyncState extends Schema.Class<SyncState>('SyncState')({
  accountId: Schema.String,
  lastFullSyncAt: Schema.NullOr(Schema.Number),
  lastSyncAt: Schema.NullOr(Schema.Number),
  /** 'calendarList' or 'events:<calendarId>'. */
  scope: Schema.String,
  status: Schema.Literals(['error', 'full_resync_needed', 'idle', 'syncing']),
  syncToken: Schema.NullOr(Schema.String),
}) {}

export const eventsScope = (calendarId: string): string => `events:${calendarId}`;
