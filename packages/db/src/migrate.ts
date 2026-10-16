import { Effect } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';
import type { SqlError } from 'effect/sql/SqlError';
import type { ResolvedMigration } from 'effect/sql/Migrator';
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
 *
 * Applied rows are matched by id and name, so a migration is never renamed
 * once it has shipped to any database.
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

    const appliedRows = yield* sql<{ migration_id: number; name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;

    // Every applied row must be a migration this build knows, by id and
    // name. One it does not know was written by a newer build (the binary
    // was downgraded), by another branch's migration under the same id, or
    // before a schema baseline replaced the migrations it came from.
    // Running this code against a schema it did not build is undefined
    // behavior — refuse loudly instead.
    const known = new Map(list.map(([id, name]) => [id, name]));
    const stranger = appliedRows.find((row) => known.get(row.migration_id) !== row.name);
    if (stranger !== undefined) {
      const ours = known.get(stranger.migration_id);
      const latest = list.at(-1)!;
      return yield* Effect.die(
        new Error(
          `Database does not match this build: it has migration ` +
            `${String(stranger.migration_id)} "${stranger.name}", which this build ` +
            (ours === undefined
              ? `does not know (it knows up to ${String(latest[0])} "${latest[1]}"). `
              : `names "${ours}". `) +
            'Update the app instead of downgrading it; a database from before the ' +
            'schema baseline is reset with `pnpm reset:local` (or by deleting the app).',
        ),
      );
    }
    const applied = new Set(appliedRows.map((row) => row.migration_id));

    // Ids must climb: the applied set is compared by id, so an entry that
    // sorts below its predecessor would apply out of order and silently.
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1]![0];
      const current = list[index]![0];
      if (current <= previous) {
        return yield* Effect.die(
          new Error(
            `Migration ids must be strictly increasing: ${String(current)} follows ` +
              `${String(previous)}.`,
          ),
        );
      }
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
