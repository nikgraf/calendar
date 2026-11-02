import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';
import { describe } from 'vite-plus/test';
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

/** An exception of series m1, as a queued delete's snapshot stores it. */
const exception = (id: string, originalStartUtc: number) => ({
  id,
  originalStartUtc,
  recurringEventId: 'm1',
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
    }).pipe(Effect.provide(sqlLayer())),
  );

  it.effect('marks a queued change of a series’ rule with where its cut’s deletes start', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* runMigrationsWith(migrations.slice(0, 1));
      const op = (id: string, kind: string, eventId: string, payload: unknown, before: unknown) =>
        sql`INSERT INTO pending_ops (id, account_id, calendar_id, kind, event_id, payload,
          before_payload, attempts, next_attempt_at, created_at)
          VALUES (${id}, 'acc-1', 'cal-1', ${kind}, ${eventId}, ${JSON.stringify(payload)},
            ${JSON.stringify(before)}, 0, 0, 1)`;
      const daily = ['RRULE:FREQ=DAILY;COUNT=5'];
      // A cut of m1 with its exceptions' deletes; a rename of m2 queued
      // after a cut that landed; a cut of m3 whose exceptions were gone.
      yield* op(
        'cut',
        'update',
        'm1',
        { recurrence: ['RRULE:FREQ=DAILY;COUNT=2'] },
        { recurrence: daily },
      );
      yield* op('d5', 'delete', 'm1_5', exception('m1_5', 5000), exception('m1_5', 5000));
      yield* op('d3', 'delete', 'm1_3', exception('m1_3', 3000), exception('m1_3', 3000));
      yield* op('rename', 'update', 'm2', { recurrence: daily, title: 'B' }, { recurrence: daily });
      yield* op(
        'bare',
        'update',
        'm3',
        { recurrence: ['RRULE:FREQ=DAILY;COUNT=2'] },
        { recurrence: daily },
      );
      yield* runMigrations;

      const rows = yield* sql<{ readonly drops_from: number | null; readonly id: string }>`
        SELECT id, drops_from FROM pending_ops WHERE kind = 'update' ORDER BY id`;
      expect(rows).toEqual([
        { drops_from: null, id: 'bare' },
        { drops_from: 3000, id: 'cut' },
        { drops_from: null, id: 'rename' },
      ]);
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

  it.effect('dies on a migration this build does not know (a newer build)', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* runMigrations;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'from-the-future')`;
      const defect: unknown = yield* runMigrations.pipe(
        Effect.catchDefect((d) => Effect.succeed<unknown>(d)),
      );
      expect(String(defect)).toContain('Database does not match this build');
      expect(String(defect)).toContain('99 "from-the-future"');
      expect(String(defect)).toContain('pnpm reset:local');
    }).pipe(Effect.provide(sqlLayer())),
  );

  it.effect('dies on a known id under another name (another branch, or a renamed migration)', () =>
    Effect.gen(function* () {
      const nextId = (migrations.at(-1)?.[0] ?? 0) + 1;
      const mine: ResolvedMigration = [nextId, 'mine', Effect.succeed(Effect.void)];
      const theirs: ResolvedMigration = [nextId, 'theirs', Effect.succeed(Effect.void)];
      yield* runMigrationsWith([...migrations, theirs]);
      const defect: unknown = yield* runMigrationsWith([...migrations, mine]).pipe(
        Effect.catchDefect((d) => Effect.succeed<unknown>(d)),
      );
      expect(String(defect)).toContain(`${String(nextId)} "theirs", which this build names "mine"`);
    }).pipe(Effect.provide(sqlLayer())),
  );

  // What a database from before the 2026-10-15 baseline looks like to this
  // build: fourteen rows, the first under the old baseline's name.
  it.effect('dies on a database from before the schema baseline', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`CREATE TABLE effect_sql_migrations (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`;
      const before = [
        'baseline',
        'event-geo',
        'apple-calendar',
        'event-reminders',
        'conflict-park',
        'carried-text',
        'calendar-mirrors',
        'rdate-series-end',
        'recurrence-cleared',
        'before-snapshot',
        'device-time-zone',
        'task-hierarchy',
        'task-due-cleared',
        'task-reorder',
      ];
      for (const [index, name] of before.entries()) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${index + 1}, ${name})`;
      }
      const defect: unknown = yield* runMigrations.pipe(
        Effect.catchDefect((d) => Effect.succeed<unknown>(d)),
      );
      expect(String(defect)).toContain('1 "baseline", which this build names');
      expect(String(defect)).toContain('pnpm reset:local');
      expect(yield* namesOf('table')).toEqual([]);
    }).pipe(Effect.provide(sqlLayer())),
  );
});
