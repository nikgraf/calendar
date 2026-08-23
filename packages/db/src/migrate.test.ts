import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import { describe } from 'vitest';
import { runMigrations } from './migrate.ts';
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
});
