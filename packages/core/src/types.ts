import { Schema } from 'effect';
import { ByDay } from './recurrence/byDay.ts';

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
  /** Weekly: the weekdays ("weekends"); monthly: one "Nth weekday". Absent = on the due day's weekday/day. */
  byDay: Schema.optional(Schema.Array(ByDay)),
  count: Schema.optional(Schema.Number),
  freq: Schema.Literals(['daily', 'monthly', 'weekly', 'yearly']),
  interval: Schema.Number,
  untilDate: Schema.optional(Schema.String),
});
export type TaskRecurrence = typeof TaskRecurrence.Type;
/** The one synthetic account that owns Apple Reminders lists on a device. */
export const APPLE_REMINDERS_ACCOUNT_ID = 'apple-reminders';
/** The one synthetic account that owns the device's Calendar app calendars (EventKit events). */
export const APPLE_CALENDAR_ACCOUNT_ID = 'apple-calendar';

export class Account extends Schema.Class<Account>('Account')({
  avatarUrl: Schema.optional(Schema.String),
  /**
   * Whether this account's token was granted the People API contacts
   * scopes (saved contacts + "other contacts"). Like tasksEnabled: derived
   * at sign-in, flipped off when a call reports the scope missing, and
   * upgraded in place by re-running "Add Google Account".
   */
  contactsEnabled: Schema.Boolean,
  createdAt: Schema.Number,
  displayName: Schema.optional(Schema.String),
  email: Schema.String,
  /** Stable local UUID — never the Google account id. */
  id: Schema.String,
  /**
   * 'google' accounts sign in via OAuth. Two synthetic 'apple' accounts can
   * exist: the device's Reminders and the device's Calendar app — tell
   * them apart with isAppleRemindersAccount / isAppleCalendarAccount.
   */
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

/** The synthetic account that mirrors Apple Reminders lists. */
export const isAppleRemindersAccount = (account: { readonly id: string }): boolean =>
  account.id === APPLE_REMINDERS_ACCOUNT_ID;

/** The synthetic account that owns the device's Calendar app calendars. */
export const isAppleCalendarAccount = (account: { readonly id: string }): boolean =>
  account.id === APPLE_CALENDAR_ACCOUNT_ID;

/** Where a typeahead suggestion came from. */
export const ContactSource = Schema.Literals(['device', 'google']);
export type ContactSource = typeof ContactSource.Type;

/** One suggestion for the invitee typeahead: a person + one email address. */
export class Contact extends Schema.Class<Contact>('Contact')({
  /** Google contacts only: the account whose address book holds it. */
  accountId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  email: Schema.String,
  /** Stable across syncs: `google:<accountId>:<resourceName>:<email>` / `device:<contactId>:<email>`. */
  id: Schema.String,
  /** Google "other contacts" (people you've emailed) rank below saved ones. */
  isOtherContact: Schema.optional(Schema.Boolean),
  source: ContactSource,
}) {}

/** A People API contact as cached in SQLite, one row per email address. */
export class GoogleContact extends Schema.Class<GoogleContact>('GoogleContact')({
  accountId: Schema.String,
  displayName: Schema.optional(Schema.String),
  email: Schema.String,
  isOther: Schema.Boolean,
  /** `people/c…` or `otherContacts/c…` — the People API's stable id. */
  resourceName: Schema.String,
}) {}

/** Where a birthday came from; a person in both address books carries both. */
export const BirthdaySource = Schema.Literals(['device', 'google']);
export type BirthdaySource = typeof BirthdaySource.Type;

export class BirthdaySourceRef extends Schema.Class<BirthdaySourceRef>('BirthdaySourceRef')({
  /** Google only: the account whose address book holds the contact. */
  accountEmail: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  /** `google:<accountId>:<resourceName>` / `device:<contactId>`. */
  id: Schema.String,
  source: BirthdaySource,
}) {}

/**
 * One person's birthday, merged across sources. Not an event: it has no
 * calendar, no time and no write path — the all-day lane renders it next
 * to tasks and the detail view names its sources.
 */
export class BirthdayRecord extends Schema.Class<BirthdayRecord>('BirthdayRecord')({
  day: Schema.Number,
  displayName: Schema.String,
  /** The first source's id — the Google one when present, so it survives device re-syncs. */
  id: Schema.String,
  month: Schema.Number,
  sources: Schema.Array(BirthdaySourceRef),
  /** Absent for year-less birthdays (the common case in address books). */
  year: Schema.optional(Schema.Number),
}) {}

/** A birthday on one calendar day — what the range query returns. */
export class BirthdayOccurrence extends Schema.Class<BirthdayOccurrence>('BirthdayOccurrence')({
  /** The age turned on `date`, when the birth year is known. */
  age: Schema.optional(Schema.Number),
  /** 'YYYY-MM-DD'. */
  date: Schema.String,
  record: BirthdayRecord,
}) {}

/** A People API birthday as cached in SQLite, one row per contact. */
export class GoogleBirthday extends Schema.Class<GoogleBirthday>('GoogleBirthday')({
  accountId: Schema.String,
  day: Schema.Number,
  displayName: Schema.String,
  month: Schema.Number,
  /** `people/c…` — the People API's stable id. */
  resourceName: Schema.String,
  year: Schema.optional(Schema.Number),
}) {}

/** Lives ONLY in the platform TokenStore (Keychain/safeStorage), never in SQLite. */
export class TokenSet extends Schema.Class<TokenSet>('TokenSet')({
  accessToken: Schema.String,
  /** Epoch ms after which accessToken is considered expired. */
  expiresAt: Schema.Number,
  refreshToken: Schema.String,
  scopes: Schema.Array(Schema.String),
}) {}

export const ReminderMethod = Schema.Literals(['email', 'popup']);
export type ReminderMethod = Schema.Schema.Type<typeof ReminderMethod>;

/** One reminder as Google models it. Only `popup` ones notify locally; `email` is Google's to send. */
export class ReminderOverride extends Schema.Class<ReminderOverride>('ReminderOverride')({
  method: ReminderMethod,
  /**
   * Minutes before the start (0..40320). For an all-day event: before
   * local midnight of the start day — Google and EventKit agree on that.
   */
  minutes: Schema.Number,
}) {}

/**
 * Google's `reminders` object, also the shape Apple alarms map onto
 * (`useDefault: false` + popup overrides). `useDefault: false` with no
 * overrides means "no reminders" and is distinct from the field being
 * absent (a row synced before reminders were modelled).
 */
export class EventReminders extends Schema.Class<EventReminders>('EventReminders')({
  overrides: Schema.Array(ReminderOverride),
  /** Google: fall back to the calendar's `defaultReminders`. Never true on Apple events. */
  useDefault: Schema.Boolean,
}) {}

export class CalendarInfo extends Schema.Class<CalendarInfo>('CalendarInfo')({
  /** Apple calendars: 'owner' when EventKit allows writes, 'reader' otherwise. */
  accessRole: AccessRole,
  accountId: Schema.String,
  colorHex: Schema.String,
  /** Google only: what `useDefault` resolves to (calendarList `defaultReminders`). */
  defaultReminders: Schema.optional(Schema.Array(ReminderOverride)),
  /** Google calendar id / EK calendarIdentifier, unique within an account (not across accounts). */
  id: Schema.String,
  /** Google: the account's primary calendar; Apple: EventKit's default for new events. */
  isPrimary: Schema.Boolean,
  /** Local show/hide toggle — not synced. */
  isVisible: Schema.Boolean,
  /** The owning account's provider (joined, never stored on the calendar row). */
  provider: TaskProvider,
  /** Apple only: the EventKit source the calendar lives in ("iCloud", "On My Mac", …). */
  sourceTitle: Schema.optional(Schema.String),
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
  /** Reminders only: EventKit refuses writes to this list (subscribed/shared read-only source). */
  readOnly: Schema.optional(Schema.Boolean),
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
  /** Reminders only: a repeat rule the app cannot express (yearly positional, several rules, month-day lists…) — never overwritten. */
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
  /** A room/equipment booking. Never shown as a guest, always written back. */
  isResource: Schema.optional(Schema.Boolean),
  isSelf: Schema.optional(Schema.Boolean),
  responseStatus: ResponseStatus,
}) {}

/**
 * Coordinates for an event's free-form `location`. Google stores only the
 * string, so these are derived on-device (MapKit) and mirrored into the
 * event's private extendedProperties. `source` is the exact location text
 * they were derived from: once the text changes (here or in any other
 * client) the coordinates are stale and discarded.
 */
export class GeoLocation extends Schema.Class<GeoLocation>('GeoLocation')({
  lat: Schema.Number,
  lng: Schema.Number,
  /** Place name MapKit returned (e.g. "Blue Bottle Coffee"), for the map pin. */
  name: Schema.optional(Schema.String),
  source: Schema.String,
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
  /** Coordinates for `location`, only while they still match it (see GeoLocation). */
  geo: Schema.optional(GeoLocation),
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
  /** Absent on Google rows synced before reminders were modelled (read as calendar default). */
  reminders: Schema.optional(EventReminders),
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

/**
 * What a series edit mirrored onto the series' exceptions, kept so the
 * queued op can undo it. Google copies a changed title, description or
 * location onto every exception and leaves a field whose value did not
 * change; the edit shows that at once and records what it replaced.
 */
export class CarriedText extends Schema.Class<CarriedText>('CarriedText')({
  /**
   * The master's text as Google last acknowledged it: what "changed" is
   * measured against, also when later edits coalesce into this op.
   */
  base: Schema.Struct({
    description: Schema.NullOr(Schema.String),
    location: Schema.NullOr(Schema.String),
    title: Schema.String,
  }),
  /**
   * Each exception's own value of every field the edit carried onto it
   * (a missing key: not carried; null: the exception had none).
   */
  overrides: Schema.Array(
    Schema.Struct({
      description: Schema.optionalKey(Schema.NullOr(Schema.String)),
      eventId: Schema.String,
      location: Schema.optionalKey(Schema.NullOr(Schema.String)),
      title: Schema.optionalKey(Schema.String),
    }),
  ),
}) {}

export class PendingOp extends Schema.Class<PendingOp>('PendingOp')({
  accountId: Schema.String,
  attempts: Schema.Number,
  /**
   * Set on an update whose edit touched the guest list. Only then does the
   * patch carry `attendees` — Google replaces the whole array, and a
   * title-only patch must not rewrite guests from a possibly stale copy.
   */
  attendeesChanged: Schema.optional(Schema.Boolean),
  /** If-Match etag captured when the op was enqueued (update/delete). */
  baseEtag: Schema.optional(Schema.String),
  calendarId: Schema.String,
  /**
   * Set on a series update that mirrored changed text onto the local
   * exceptions: abandoning the op (discard, take theirs, a permanent
   * rejection) puts their own text back.
   */
  carriedText: Schema.optional(CarriedText),
  /** New calendar color for kind 'calendarColor' (lowercase #rrggbb). */
  colorHex: Schema.optional(Schema.String),
  /**
   * Set when a 412 parked the op (update/delete): the drain skips it until
   * the user keeps their version or takes Google's.
   */
  conflictAt: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
  /**
   * Set just before a non-idempotent network call (createTask). A re-run
   * that finds it set must verify with the server before inserting again
   * — the first request may have landed even though we never saw the
   * response.
   */
  dispatchedAt: Schema.optional(Schema.Number),
  eventId: Schema.String,
  /**
   * Set on an update whose edit dropped the event's coordinates (its
   * location changed). Only then does the patch delete the private geo
   * keys on the server — sending deletes for keys that were never there
   * would ride on every unrelated edit.
   */
  geoCleared: Schema.optional(Schema.Boolean),
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
  /**
   * Snapshot of the event: what to send for create/update, and the row as
   * it was when deleted for delete (so a parked delete can be named).
   */
  payload: Schema.optional(EventRecord),
  /**
   * Set on an update whose edit touched the reminders. Only then does the
   * patch carry `reminders` — Google replaces the whole object, and an
   * unrelated edit must not rewrite it from a possibly stale copy.
   */
  remindersChanged: Schema.optional(Schema.Boolean),
  /**
   * Google's version fetched when the op was parked; absent on a parked op
   * means the event was deleted on Google.
   */
  serverPayload: Schema.optional(EventRecord),
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
  /** Kind 'move': destination calendar in the same Google account (calendarId is the source). */
  targetCalendarId: Schema.optional(Schema.String),
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
