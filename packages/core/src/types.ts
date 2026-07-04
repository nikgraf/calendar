import { Schema } from 'effect';

export const AccountStatus = Schema.Literals(['ok', 'reauth_required']);
export const AccessRole = Schema.Literals(['freeBusyReader', 'owner', 'reader', 'writer']);
export const EventStatus = Schema.Literals(['cancelled', 'confirmed', 'tentative']);
export const SyncStatus = Schema.Literals(['error', 'pending', 'synced']);
export const ResponseStatus = Schema.Literals(['accepted', 'declined', 'needsAction', 'tentative']);

export class Account extends Schema.Class<Account>('Account')({
  avatarUrl: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  displayName: Schema.optional(Schema.String),
  email: Schema.String,
  /** Stable local UUID — never the Google account id. */
  id: Schema.String,
  status: AccountStatus,
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
  createdAt: Schema.Number,
  eventId: Schema.String,
  id: Schema.String,
  kind: Schema.Literals(['create', 'delete', 'rsvp', 'update']),
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
