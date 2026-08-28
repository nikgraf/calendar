import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import type { ResolvedMigration } from 'effect/unstable/sql/Migrator';
import { migrations } from './migrations.ts';

/**
 * Minimal migration runner. Replaces effect's Migrator because that module
 * carries a dynamic-import glob loader Metro cannot parse; this uses the same
 * table shape (effect_sql_migrations), so databases migrated by either
 * implementation stay compatible.
 *
 * Each migration and its bookkeeping row commit in one transaction: a
 * mid-migration failure rolls back to the last fully-applied migration
 * (SQLite DDL is transactional), so the next launch retries cleanly instead
 * of hitting half-applied DDL forever.
 */
export const runMigrationsWith = (
  list: ReadonlyArray<ResolvedMigration>,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const ids = list.map(([id]) => id);
    const firstDuplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (firstDuplicate !== undefined) {
      return yield* Effect.die(
        new Error(
          `Duplicate migration id ${String(firstDuplicate)} — every migration needs a unique id`,
        ),
      );
    }

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

    // A database already migrated past everything this build knows about
    // means the app binary was downgraded. Running old code against a newer
    // schema is undefined behavior — refuse loudly instead.
    const latestKnown = Math.max(...ids);
    const ahead = [...applied].filter((id) => id > latestKnown);
    if (ahead.length > 0) {
      return yield* Effect.die(
        new Error(
          `Database is ahead of this build: migration ${String(Math.max(...ahead))} is applied ` +
            `but this build only knows up to ${String(latestKnown)}. ` +
            'Update the app instead of downgrading it.',
        ),
      );
    }

    for (const [id, name, load] of list) {
      if (applied.has(id)) {
        continue;
      }
      const migration = (yield* load) as Effect.Effect<unknown, SqlError, SqlClient>;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* migration;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (${id}, ${name})`;
        }),
      );
    }
  });

export const runMigrations: Effect.Effect<void, SqlError, SqlClient> =
  runMigrationsWith(migrations);
