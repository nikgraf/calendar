import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { migrations } from './migrations.ts';

/**
 * Minimal migration runner. Replaces effect's Migrator because that module
 * carries a dynamic-import glob loader Metro cannot parse; this uses the same
 * table shape (effect_sql_migrations), so databases migrated by either
 * implementation stay compatible.
 */
export const runMigrations: Effect.Effect<void, SqlError, SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS effect_sql_migrations (
    migration_id integer PRIMARY KEY NOT NULL,
    created_at datetime NOT NULL DEFAULT current_timestamp,
    name VARCHAR(255) NOT NULL
  )`;

  const applied = new Set(
    (yield* sql<{ migration_id: number }>`
      SELECT migration_id FROM effect_sql_migrations
    `).map((row) => row.migration_id),
  );

  for (const [id, name, load] of migrations) {
    if (applied.has(id)) {
      continue;
    }
    const migration = (yield* load) as Effect.Effect<unknown, SqlError, SqlClient>;
    yield* migration;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${id}, ${name})`;
  }
});
