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

// The third tuple element is a *loader* whose result is the migration effect.
export const migrations: ReadonlyArray<ResolvedMigration> = [
  [1, 'init', Effect.succeed(init)],
  [2, 'add-hangout-link', Effect.succeed(addHangoutLink)],
  [3, 'add-pending-op-color-hex', Effect.succeed(addPendingOpColorHex)],
];

export const migrationsLoader = Effect.succeed(migrations);
