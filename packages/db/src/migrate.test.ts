import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';
import { describe } from 'vitest';
import type { ResolvedMigration } from 'effect/sql/Migrator';
import { runMigrations, runMigrationsWith } from './migrate.ts';
import { migrations } from './migrations.ts';

const sqlLayer = () => SqliteClient.layer({ filename: ':memory:' });

const appliedIds = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{
    migration_id: number;
  }>`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`;
  return rows.map((row) => row.migration_id);
});

const namesOf = (type: 'index' | 'table') =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = ${type} AND name NOT LIKE 'sqlite_%' AND name <> 'effect_sql_migrations'
      ORDER BY name`;
    return rows.map((row) => row.name);
  });

const columnsOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`;
    return rows.map((row) => row.name);
  });

describe('runMigrations', () => {
  it.effect('builds the whole schema on a fresh database', () =>
    Effect.gen(function* () {
      yield* runMigrations;
      expect(yield* appliedIds).toEqual(migrations.map(([id]) => id));
      expect(yield* namesOf('table')).toEqual([
        'accounts',
        'calendars',
        'contact_birthdays',
        'contacts',
        'device_settings',
        'events',
        'location_geo',
        'pending_ops',
        'sync_state',
        'task_lists',
        'tasks',
      ]);
      expect(yield* namesOf('index')).toEqual([
        'idx_contacts_email',
        'idx_events_masters',
        'idx_events_mirror',
        'idx_events_range',
        'idx_events_recurring',
        'idx_events_stale',
        'idx_events_window',
        'idx_pending_ops_due',
        'idx_tasks_due',
      ]);
      // A few columns that arrived late in the pre-baseline history.
      expect(yield* columnsOf('events')).toContain('recurrence_end_utc');
      expect(yield* columnsOf('pending_ops')).toContain('attendees_changed');
      expect(yield* columnsOf('task_lists')).toContain('read_only');
      expect(yield* columnsOf('accounts')).toContain('contacts_enabled');
      expect(yield* columnsOf('events')).toContain('geo');
      expect(yield* columnsOf('pending_ops')).toContain('geo_cleared');
      expect(yield* columnsOf('pending_ops')).toContain('conflict_at');
      expect(yield* columnsOf('pending_ops')).toContain('server_payload');
      expect(yield* columnsOf('pending_ops')).toContain('carried_text');
      expect(yield* columnsOf('events')).toEqual(
        expect.arrayContaining(['mirror', 'transparency', 'visibility']),
      );
      expect(yield* columnsOf('tasks')).toEqual(expect.arrayContaining(['due_utc', 'external_id']));
    }).pipe(Effect.provide(sqlLayer())),
  );

  it.effect('upgrades a baseline database in place, keeping its rows', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const baselineOnly = migrations.filter(([id]) => id === 1);
      yield* runMigrationsWith(baselineOnly);
      yield* sql`INSERT INTO accounts (id, email, status, created_at) VALUES ('a', 'a@x', 'ok', 1)`;
      yield* sql`
        INSERT INTO events (account_id, calendar_id, id, status, title, location, is_all_day,
                            start_utc, end_utc, sync_status, updated_at, synced_at)
        VALUES ('a', 'c', 'e', 'confirmed', 'Lunch', 'Naschmarkt', 0, 1, 2, 'synced', 1, 1)`;

      yield* runMigrations;

      expect(yield* appliedIds).toEqual(migrations.map(([id]) => id));
      const rows = yield* sql<{ geo: string | null; location: string }>`
        SELECT location, geo FROM events WHERE id = 'e'`;
      expect(rows).toEqual([{ geo: null, location: 'Naschmarkt' }]);
    }).pipe(Effect.provide(sqlLayer())),
  );

  it.effect('backfills the series end of masters with RDATE lines (migration 8)', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* runMigrationsWith(migrations.filter(([id]) => id < 8));
      const insert = (id: string, recurrence: ReadonlyArray<string>) => sql`
        INSERT INTO events (account_id, calendar_id, id, status, title, is_all_day, start_utc,
                            end_utc, start_time_zone, recurrence, recurrence_end_utc,
                            sync_status, updated_at, synced_at)
        VALUES ('a', 'c', ${id}, 'confirmed', 'Talks', 0, ${Date.parse('2026-07-07T09:00:00Z')},
                ${Date.parse('2026-07-07T10:00:00Z')}, 'UTC', ${JSON.stringify(recurrence)}, NULL,
                'synced', 1, 1)`;
      yield* insert('dates', ['RDATE:20260801T090000Z,20260901T090000Z']);
      yield* insert('rule-and-dates', ['RRULE:FREQ=WEEKLY;COUNT=2', 'RDATE:20261001T090000Z']);
      yield* insert('endless', ['RRULE:FREQ=WEEKLY', 'RDATE:20261001T090000Z']);

      yield* runMigrations;

      const rows = yield* sql<{ id: string; recurrence_end_utc: number | null }>`
        SELECT id, recurrence_end_utc FROM events ORDER BY id`;
      expect(rows).toEqual([
        { id: 'dates', recurrence_end_utc: Date.parse('2026-09-01T10:00:00Z') },
        { id: 'endless', recurrence_end_utc: null },
        { id: 'rule-and-dates', recurrence_end_utc: Date.parse('2026-10-01T10:00:00Z') },
      ]);
    }).pipe(Effect.provide(sqlLayer())),
  );

  it.effect('is idempotent — a second run applies nothing', () =>
    Effect.gen(function* () {
      yield* runMigrations;
      // Would throw "table already exists" if the baseline ran twice.
      yield* runMigrations;
      expect(yield* appliedIds).toEqual(migrations.map(([id]) => id));
    }).pipe(Effect.provide(sqlLayer())),
  );

  it.effect('rolls back a failing migration atomically and retries it next run', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      // One past the last real migration, whatever that is today.
      const nextId = (migrations.at(-1)?.[0] ?? 0) + 1;
      const broken: ResolvedMigration = [
        nextId,
        'partial-failure',
        Effect.succeed(
          Effect.gen(function* () {
            yield* sql`CREATE TABLE half_done (id TEXT PRIMARY KEY)`;
            yield* sql`THIS IS NOT SQL`;
          }),
        ),
      ];
      const result = yield* Effect.result(runMigrationsWith([...migrations, broken]));
      expect(result._tag).toBe('Failure');

      // The failed migration left nothing behind: neither its first
      // statement nor a bookkeeping row survived the rollback.
      const tables = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE name = 'half_done'`;
      expect(tables.length).toBe(0);
      expect(yield* appliedIds).toEqual(migrations.map(([id]) => id));

      // A later run with the migration fixed applies it cleanly.
      const fixed: ResolvedMigration = [
        nextId,
        'partial-failure',
        Effect.succeed(
          Effect.gen(function* () {
            yield* sql`CREATE TABLE half_done (id TEXT PRIMARY KEY)`;
          }),
        ),
      ];
      yield* runMigrationsWith([...migrations, fixed]);
      expect(yield* appliedIds).toEqual([...migrations.map(([id]) => id), nextId]);
    }).pipe(Effect.provide(sqlLayer())),
  );

  it.effect('dies on duplicate migration ids', () =>
    Effect.gen(function* () {
      const dup: ResolvedMigration = [1, 'dup-of-baseline', Effect.succeed(Effect.void)];
      const defect: unknown = yield* runMigrationsWith([...migrations, dup]).pipe(
        Effect.catchDefect((d) => Effect.succeed<unknown>(d)),
      );
      expect(String(defect)).toContain('Duplicate migration id 1');
    }).pipe(Effect.provide(sqlLayer())),
  );

  it.effect('dies when migration ids do not climb', () =>
    Effect.gen(function* () {
      const nextId = (migrations.at(-1)?.[0] ?? 0) + 1;
      const later: ResolvedMigration = [nextId + 1, 'later', Effect.succeed(Effect.void)];
      const earlier: ResolvedMigration = [nextId, 'earlier', Effect.succeed(Effect.void)];
      const defect: unknown = yield* runMigrationsWith([...migrations, later, earlier]).pipe(
        Effect.catchDefect((d) => Effect.succeed<unknown>(d)),
      );
      expect(String(defect)).toContain('strictly increasing');
    }).pipe(Effect.provide(sqlLayer())),
  );

  // Also what a database from before the 2026-09-15 baseline looks like to
  // this build: its migration rows 2–12 are unknown here, so it refuses to
  // open rather than run against a schema it did not build.
  it.effect('dies when the database is ahead of the build (downgrade guard)', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* runMigrations;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'from-the-future')`;
      const defect: unknown = yield* runMigrations.pipe(
        Effect.catchDefect((d) => Effect.succeed<unknown>(d)),
      );
      expect(String(defect)).toContain('Database is ahead of this build');
      expect(String(defect)).toContain('99');
      expect(String(defect)).toContain('pnpm reset:local');
    }).pipe(Effect.provide(sqlLayer())),
  );
});
