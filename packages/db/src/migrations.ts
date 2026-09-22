import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { ResolvedMigration } from 'effect/unstable/sql/Migrator';

// The whole schema in one migration. Twelve incremental migrations accreted
// while building and were collapsed before the first release (2026-09-15);
// a database from before the collapse refuses to open (see the runner's
// "ahead of this build" guard) and is reset with `pnpm reset:local`.
// From here on, schema changes are new migrations appended below.
const baseline = Effect.gen(function* () {
  const sql = yield* SqlClient;

  // provider: 'google' (OAuth accounts) or 'apple' (the one synthetic
  // Reminders account). tasks_enabled / contacts_enabled derive from
  // TokenSet.scopes at sign-in.
  yield* sql`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'google',
      tasks_enabled INTEGER NOT NULL DEFAULT 0,
      contacts_enabled INTEGER NOT NULL DEFAULT 0
    )`;

  yield* sql`
    CREATE TABLE calendars (
      account_id TEXT NOT NULL,
      id TEXT NOT NULL,
      summary TEXT NOT NULL,
      color_hex TEXT NOT NULL,
      access_role TEXT NOT NULL,
      is_primary INTEGER NOT NULL,
      is_visible INTEGER NOT NULL,
      time_zone TEXT NOT NULL,
      PRIMARY KEY (account_id, id)
    )`;

  // recurrence_end_utc: when a recurring series ends (UNTIL, or the last
  // COUNT occurrence); NULL = never. Lets the window query skip series
  // that ended before the range instead of expanding every master stored.
  yield* sql`
    CREATE TABLE events (
      account_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      id TEXT NOT NULL,
      etag TEXT,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT,
      description TEXT,
      is_all_day INTEGER NOT NULL,
      start_utc INTEGER NOT NULL,
      end_utc INTEGER NOT NULL,
      start_date TEXT,
      end_date TEXT,
      start_time_zone TEXT,
      recurrence TEXT,
      recurrence_end_utc INTEGER,
      recurring_event_id TEXT,
      original_start_utc INTEGER,
      attendees TEXT,
      organizer_email TEXT,
      hangout_link TEXT,
      sync_status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, calendar_id, id)
    )`;
  yield* sql`CREATE INDEX idx_events_range ON events (calendar_id, start_utc, end_utc)`;
  yield* sql`CREATE INDEX idx_events_recurring ON events (recurring_event_id)`;
  // EventRepo.getWindow never filters on calendar_id, so idx_events_range
  // cannot serve it.
  yield* sql`CREATE INDEX idx_events_window ON events (start_utc, end_utc)`;
  // deleteStale runs over a whole calendar after a full pass.
  yield* sql`CREATE INDEX idx_events_stale
    ON events (account_id, calendar_id, sync_status, synced_at)`;
  // Partial: the masters query would otherwise touch nearly every row
  // through the window index and filter `recurrence IS NOT NULL` afterwards.
  yield* sql`CREATE INDEX idx_events_masters
    ON events (start_utc, recurrence_end_utc) WHERE recurrence IS NOT NULL`;

  // Op-specific state lives in scalar columns (color_hex, task_*,
  // attendees_changed) rather than inside `payload`. dispatched_at is
  // stamped before a non-idempotent network call (tasks.insert has
  // server-assigned ids) so a re-run verifies against the server before
  // inserting again. attendees_changed = 1 when the queued update carries
  // an edited guest list; only then does the patch include `attendees`.
  yield* sql`
    CREATE TABLE pending_ops (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload TEXT,
      base_etag TEXT,
      color_hex TEXT,
      task_list_id TEXT,
      task_status TEXT,
      task_title TEXT,
      task_notes TEXT,
      task_due TEXT,
      attendees_changed INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    )`;
  // listDue: `WHERE next_attempt_at <= ? ORDER BY created_at`.
  yield* sql`CREATE INDEX idx_pending_ops_due ON pending_ops (next_attempt_at, created_at)`;

  yield* sql`
    CREATE TABLE sync_state (
      account_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      sync_token TEXT,
      last_full_sync_at INTEGER,
      last_sync_at INTEGER,
      status TEXT NOT NULL,
      PRIMARY KEY (account_id, scope)
    )`;

  // read_only mirrors EKCalendar.allowsContentModifications — 1 for lists
  // EventKit will not let us write (a read-only CalDAV/Exchange source).
  yield* sql`
    CREATE TABLE task_lists (
      account_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'google',
      color_hex TEXT,
      is_visible INTEGER NOT NULL DEFAULT 1,
      read_only INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, id)
    )`;

  // sync_status 'pending' marks optimistic local creates so a full-pass
  // deleteStale never eats a row whose insert has not pushed yet. due_time,
  // priority, url, alarms (JSON number[] of minute offsets) and recurrence
  // (JSON TaskRecurrence or {"unsupported":true}) are Reminders
  // capabilities Google Tasks lack — NULL for Google rows.
  yield* sql`
    CREATE TABLE tasks (
      account_id TEXT NOT NULL,
      list_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL,
      due_date TEXT,
      due_time TEXT,
      priority TEXT,
      url TEXT,
      alarms TEXT,
      recurrence TEXT,
      completed_at INTEGER,
      web_view_link TEXT,
      sync_status TEXT NOT NULL DEFAULT 'synced',
      updated_at INTEGER NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, list_id, id)
    )`;
  // TaskRepo.getWindow range-scans due_date; the complete Reminders mirror
  // makes tasks the largest table.
  yield* sql`CREATE INDEX idx_tasks_due ON tasks (due_date)`;

  // People API cache, one row per (person, email). is_other splits saved
  // contacts from "other contacts" so each tier syncs (and is replaced)
  // on its own sync token.
  yield* sql`
    CREATE TABLE contacts (
      account_id TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      email_lower TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT,
      is_other INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, resource_name, email_lower)
    )`;
  yield* sql`CREATE INDEX idx_contacts_email ON contacts (email_lower)`;

  // People API birthdays (connections tier), one row per contact — a
  // person needs no email address to have a birthday, so this is not a
  // column on `contacts` (whose key includes the email).
  yield* sql`
    CREATE TABLE contact_birthdays (
      account_id TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      month INTEGER NOT NULL,
      day INTEGER NOT NULL,
      year INTEGER,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, resource_name)
    )`;

  // Device-local preferences that never sync (birthday reminders are the
  // first). SQLite is per device and never uploaded, so "device-local" is
  // a property of the table, not of a separate settings file.
  yield* sql`
    CREATE TABLE device_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
});

// Structured locations. events.geo mirrors the coordinates stored in the
// Google event's private extendedProperties (JSON GeoLocation; NULL = none
// on the server). location_geo caches on-device geocoding per normalized
// location string for events without server coordinates (read-only
// calendars, events from before the feature); geo NULL there records a
// lookup that found nothing, so it is not repeated on every open.
const eventGeo = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`ALTER TABLE events ADD COLUMN geo TEXT`;
  // geo_cleared = 1 when the queued update must delete the server's geo keys.
  yield* sql`ALTER TABLE pending_ops ADD COLUMN geo_cleared INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE TABLE location_geo (
      location_key TEXT PRIMARY KEY NOT NULL,
      geo TEXT,
      resolved_at INTEGER NOT NULL
    )`;
});

// Apple Calendar. source_title is the EventKit source an Apple calendar
// lives in ("iCloud", "On My Mac") — NULL for Google calendars; the
// calendar's provider is never stored, it is the owning account's.
// target_calendar_id is the destination of a queued 'move' op (a Google
// events.move inside one account; calendar_id stays the source).
const appleCalendar = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`ALTER TABLE calendars ADD COLUMN source_title TEXT`;
  yield* sql`ALTER TABLE pending_ops ADD COLUMN target_calendar_id TEXT`;
});

// Event reminders. events.reminders is the JSON EventReminders (NULL =
// synced before reminders were modelled, read as the calendar default);
// calendars.default_reminders the JSON ReminderOverride[] from Google's
// calendarList; reminders_changed = 1 when the queued update must carry
// the reminders object. The Google events sync tokens are dropped so every
// calendar re-lists once and fills the new column — a row left NULL would
// fire at the calendar default even where the user chose "none".
const eventReminders = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`ALTER TABLE events ADD COLUMN reminders TEXT`;
  yield* sql`ALTER TABLE calendars ADD COLUMN default_reminders TEXT`;
  yield* sql`ALTER TABLE pending_ops ADD COLUMN reminders_changed INTEGER NOT NULL DEFAULT 0`;
  yield* sql`DELETE FROM sync_state WHERE scope LIKE 'events:%'`;
});

// The third tuple element is a *loader* whose result is the migration effect.
export const migrations: ReadonlyArray<ResolvedMigration> = [
  [1, 'baseline', Effect.succeed(baseline)],
  [2, 'event-geo', Effect.succeed(eventGeo)],
  [3, 'apple-calendar', Effect.succeed(appleCalendar)],
  [4, 'event-reminders', Effect.succeed(eventReminders)],
];
