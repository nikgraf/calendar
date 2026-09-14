import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import { describe } from 'vitest';
import type { ResolvedMigration } from 'effect/unstable/sql/Migrator';
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

const columnsOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`;
    return rows.map((row) => row.name);
  });

describe('runMigrations', () => {
  it.effect('applies every migration once on a fresh database', () =>
    Effect.gen(function* () {
      yield* runMigrations;
      expect(yield* appliedIds).toEqual(migrations.map(([id]) => id));
      expect(yield* columnsOf('events')).toContain('hangout_link');
      expect(yield* columnsOf('pending_ops')).toContain('color_hex');
      expect(yield* columnsOf('pending_ops')).toContain('task_status');
      expect(yield* columnsOf('pending_ops')).toContain('task_due');
      expect(yield* columnsOf('tasks')).toContain('sync_status');
      expect(yield* columnsOf('accounts')).toContain('tasks_enabled');
      expect(yield* columnsOf('tasks')).toContain('due_date');
    }).pipe(Effect.provide(sqlLayer())),
  );

  it.effect('full history: clears event sync tokens, keeps others, drops orphan events', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* runMigrations;
      // Rewind to v11: forget the migration and undo its schema.
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 12`;
      yield* sql`DROP INDEX IF EXISTS idx_events_masters`;
      yield* sql`DROP INDEX IF EXISTS idx_events_stale`;
      yield* sql`ALTER TABLE events DROP COLUMN recurrence_end_utc`;
      yield* sql`INSERT INTO accounts (id, email, status, created_at, provider, tasks_enabled, contacts_enabled)
        VALUES ('acc', 'a@example.com', 'ok', 1, 'google', 0, 0)`;
      yield* sql`INSERT INTO calendars (account_id, id, summary, color_hex, is_visible, is_primary, access_role, time_zone)
        VALUES ('acc', 'cal', 'Cal', '#000000', 1, 1, 'owner', 'UTC')`;
      yield* sql`INSERT INTO sync_state (account_id, scope, sync_token, last_full_sync_at, last_sync_at, status)
        VALUES ('acc', 'events:cal', 'tok', 1, 1, 'idle'), ('acc', 'calendarList', 'tok2', 1, 1, 'idle')`;
      const event = (calendarId: string, id: string) => sql`
        INSERT INTO events (account_id, calendar_id, id, etag, status, title, is_all_day,
                            start_utc, end_utc, sync_status, updated_at, synced_at)
        VALUES ('acc', ${calendarId}, ${id}, NULL, 'confirmed', ${id}, 0, 0, 1, 'synced', 1, 1)`;
      yield* event('cal', 'kept');
      yield* event('gone', 'orphan');

      yield* runMigrations;
      const tokens = yield* sql<{ scope: string; sync_token: string | null }>`
        SELECT scope, sync_token FROM sync_state ORDER BY scope`;
      expect(tokens).toEqual([
        { scope: 'calendarList', sync_token: 'tok2' },
        { scope: 'events:cal', sync_token: null },
      ]);
      const ids = yield* sql<{ id: string }>`SELECT id FROM events ORDER BY id`;
      expect(ids.map((row) => row.id)).toEqual(['kept']);
      expect(yield* columnsOf('events')).toContain('recurrence_end_utc');
    }).pipe(Effect.provide(sqlLayer())),
  );

  it.effect('is idempotent — a second run applies nothing', () =>
    Effect.gen(function* () {
      yield* runMigrations;
      // Would throw "duplicate column name" if the ALTERs ran twice.
      yield* runMigrations;
      expect(yield* appliedIds).toEqual(migrations.map(([id]) => id));
    }).pipe(Effect.provide(sqlLayer())),
  );

  it.effect('upgrades a v1 database rather than only replaying on a fresh one', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      // Simulate an install that stopped at migration 1: run it, then forget
      // the later ones ever existed.
      yield* runMigrations;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > 1`;
      yield* sql`ALTER TABLE events DROP COLUMN hangout_link`;
      // An indexed column cannot be dropped; the partial index goes first.
      yield* sql`DROP INDEX IF EXISTS idx_events_masters`;
      yield* sql`ALTER TABLE events DROP COLUMN recurrence_end_utc`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN color_hex`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN task_list_id`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN task_status`;
      yield* sql`ALTER TABLE accounts DROP COLUMN tasks_enabled`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN task_title`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN task_notes`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN task_due`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN dispatched_at`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN attendees_changed`;
      yield* sql`ALTER TABLE accounts DROP COLUMN provider`;
      yield* sql`ALTER TABLE accounts DROP COLUMN contacts_enabled`;
      yield* sql`DROP TABLE tasks`;
      yield* sql`DROP TABLE task_lists`;
      yield* sql`DROP TABLE contacts`;
      yield* sql`DROP TABLE contact_birthdays`;
      yield* sql`DROP TABLE device_settings`;
      expect(yield* columnsOf('events')).not.toContain('hangout_link');

      yield* runMigrations;
      expect(yield* appliedIds).toEqual(migrations.map(([id]) => id));
      expect(yield* columnsOf('events')).toContain('hangout_link');
      expect(yield* columnsOf('pending_ops')).toContain('color_hex');
      expect(yield* columnsOf('tasks')).toContain('due_date');
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
      const dup: ResolvedMigration = [1, 'dup-of-init', Effect.succeed(Effect.void)];
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
    }).pipe(Effect.provide(sqlLayer())),
  );
});
