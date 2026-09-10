import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { ResolvedMigration } from 'effect/unstable/sql/Migrator';

const init = Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
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
      recurring_event_id TEXT,
      original_start_utc INTEGER,
      attendees TEXT,
      organizer_email TEXT,
      sync_status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, calendar_id, id)
    )`;

  yield* sql`CREATE INDEX idx_events_range ON events (calendar_id, start_utc, end_utc)`;
  yield* sql`CREATE INDEX idx_events_recurring ON events (recurring_event_id)`;

  yield* sql`
    CREATE TABLE pending_ops (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload TEXT,
      base_etag TEXT,
      attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL
    )`;

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
});

const addHangoutLink = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`ALTER TABLE events ADD COLUMN hangout_link TEXT`;
});

const addPendingOpColorHex = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`ALTER TABLE pending_ops ADD COLUMN color_hex TEXT`;
});

const addTasks = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`
    CREATE TABLE task_lists (
      account_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      is_visible INTEGER NOT NULL DEFAULT 1,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, id)
    )`;
  yield* sql`
    CREATE TABLE tasks (
      account_id TEXT NOT NULL,
      list_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL,
      due_date TEXT,
      completed_at INTEGER,
      web_view_link TEXT,
      updated_at INTEGER NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, list_id, id)
    )`;
  // completeTask ops carry their state in scalar columns, like color_hex.
  yield* sql`ALTER TABLE pending_ops ADD COLUMN task_list_id TEXT`;
  yield* sql`ALTER TABLE pending_ops ADD COLUMN task_status TEXT`;
  // Derived from TokenSet.scopes at sign-in; 0 for pre-Tasks accounts.
  yield* sql`ALTER TABLE accounts ADD COLUMN tasks_enabled INTEGER NOT NULL DEFAULT 0`;
});

const addTaskWrites = Effect.gen(function* () {
  const sql = yield* SqlClient;
  // createTask/updateTask ops carry their fields in scalar columns, like
  // color_hex and task_status before them.
  yield* sql`ALTER TABLE pending_ops ADD COLUMN task_title TEXT`;
  yield* sql`ALTER TABLE pending_ops ADD COLUMN task_notes TEXT`;
  yield* sql`ALTER TABLE pending_ops ADD COLUMN task_due TEXT`;
  // Stamped before a non-idempotent network call (tasks.insert has
  // server-assigned ids): a re-run with the stamp set verifies against
  // the server before inserting again.
  yield* sql`ALTER TABLE pending_ops ADD COLUMN dispatched_at INTEGER`;
  // 'pending' marks optimistic local creates so a full-pass deleteStale
  // never eats a row whose insert has not pushed yet (the events pattern).
  yield* sql`ALTER TABLE tasks ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'synced'`;
});

const addReminders = Effect.gen(function* () {
  const sql = yield* SqlClient;
  // Provider discriminator: 'google' (OAuth accounts) or 'apple' (the one
  // synthetic Reminders account). Existing rows are all Google.
  yield* sql`ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'`;
  yield* sql`ALTER TABLE task_lists ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'`;
  yield* sql`ALTER TABLE task_lists ADD COLUMN color_hex TEXT`;
  // Reminders capabilities Google Tasks lack — NULL for Google rows.
  yield* sql`ALTER TABLE tasks ADD COLUMN due_time TEXT`;
  yield* sql`ALTER TABLE tasks ADD COLUMN priority TEXT`;
  yield* sql`ALTER TABLE tasks ADD COLUMN url TEXT`;
  // JSON: number[] of minute offsets / a TaskRecurrence (or {"unsupported":true}).
  yield* sql`ALTER TABLE tasks ADD COLUMN alarms TEXT`;
  yield* sql`ALTER TABLE tasks ADD COLUMN recurrence TEXT`;
});

const addTaskListReadOnly = Effect.gen(function* () {
  const sql = yield* SqlClient;
  // EKCalendar.allowsContentModifications — 1 for lists EventKit will not
  // let us write (a read-only CalDAV/Exchange source). Google lists and
  // existing rows are writable.
  yield* sql`ALTER TABLE task_lists ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0`;
});

const addContacts = Effect.gen(function* () {
  const sql = yield* SqlClient;
  // Derived from TokenSet.scopes at sign-in; 0 for pre-contacts accounts.
  yield* sql`ALTER TABLE accounts ADD COLUMN contacts_enabled INTEGER NOT NULL DEFAULT 0`;
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
});

const addPendingOpAttendeesChanged = Effect.gen(function* () {
  const sql = yield* SqlClient;
  // 1 when the queued update carries an edited guest list; only then does
  // the patch include `attendees` (Google replaces the whole array).
  yield* sql`ALTER TABLE pending_ops ADD COLUMN attendees_changed INTEGER NOT NULL DEFAULT 0`;
});

// The third tuple element is a *loader* whose result is the migration effect.
export const migrations: ReadonlyArray<ResolvedMigration> = [
  [1, 'init', Effect.succeed(init)],
  [2, 'add-hangout-link', Effect.succeed(addHangoutLink)],
  [3, 'add-pending-op-color-hex', Effect.succeed(addPendingOpColorHex)],
  [4, 'add-tasks', Effect.succeed(addTasks)],
  [5, 'add-task-writes', Effect.succeed(addTaskWrites)],
  [6, 'add-reminders', Effect.succeed(addReminders)],
  [7, 'add-task-list-read-only', Effect.succeed(addTaskListReadOnly)],
  [8, 'add-contacts', Effect.succeed(addContacts)],
  [9, 'add-pending-op-attendees-changed', Effect.succeed(addPendingOpAttendeesChanged)],
];
