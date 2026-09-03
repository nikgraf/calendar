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
      yield* sql`ALTER TABLE pending_ops DROP COLUMN color_hex`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN task_list_id`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN task_status`;
      yield* sql`ALTER TABLE accounts DROP COLUMN tasks_enabled`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN task_title`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN task_notes`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN task_due`;
      yield* sql`ALTER TABLE pending_ops DROP COLUMN dispatched_at`;
      yield* sql`ALTER TABLE accounts DROP COLUMN provider`;
      yield* sql`DROP TABLE tasks`;
      yield* sql`DROP TABLE task_lists`;
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
      const broken: ResolvedMigration = [
        7,
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
        7,
        'partial-failure',
        Effect.succeed(
          Effect.gen(function* () {
            yield* sql`CREATE TABLE half_done (id TEXT PRIMARY KEY)`;
          }),
        ),
      ];
      yield* runMigrationsWith([...migrations, fixed]);
      expect(yield* appliedIds).toEqual([...migrations.map(([id]) => id), 7]);
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
