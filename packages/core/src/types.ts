import { Schema } from 'effect';

export const AccountStatus = Schema.Literals(['ok', 'reauth_required']);
export const AccessRole = Schema.Literals(['freeBusyReader', 'owner', 'reader', 'writer']);
export const EventStatus = Schema.Literals(['cancelled', 'confirmed', 'tentative']);
export const SyncStatus = Schema.Literals(['error', 'pending', 'synced']);
export const ResponseStatus = Schema.Literals(['accepted', 'declined', 'needsAction', 'tentative']);
export const TaskStatus = Schema.Literals(['completed', 'needsAction']);

export class Account extends Schema.Class<Account>('Account')({
  avatarUrl: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  displayName: Schema.optional(Schema.String),
  email: Schema.String,
  /** Stable local UUID — never the Google account id. */
  id: Schema.String,
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
  /** Google task-list id, unique within an account. */
  id: Schema.String,
  /** Local show/hide toggle — not synced to Google. */
  isVisible: Schema.Boolean,
  title: Schema.String,
}) {}

export class TaskRecord extends Schema.Class<TaskRecord>('TaskRecord')({
  accountId: Schema.String,
  /** Epoch ms of completion; absent while the task is open. */
  completedAt: Schema.optional(Schema.Number),
  /**
   * Due day as 'YYYY-MM-DD' — the Tasks API discards the time portion, so
   * this is date-only by construction. Absent for undated tasks.
   */
  dueDate: Schema.optional(Schema.String),
  /** Google task id, unique within its list. */
  id: Schema.String,
  listId: Schema.String,
  notes: Schema.optional(Schema.String),
  status: TaskStatus,
  title: Schema.String,
  updatedAt: Schema.Number,
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
  eventId: Schema.String,
  id: Schema.String,
  kind: Schema.Literals(['calendarColor', 'create', 'delete', 'rsvp', 'update']),
  lastError: Schema.optional(Schema.String),
  nextAttemptAt: Schema.Number,
  /** Snapshot of the event to send (create/update). */
  payload: Schema.optional(EventRecord),
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
