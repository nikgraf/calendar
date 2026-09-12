import { type GoogleBirthday } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { BIRTHDAYS_KEY } from './keys.ts';
import { googleBirthdayFromRow, type ContactBirthdayRow } from './rows.ts';
import { accountGuard } from './repoShared.ts';

export interface BirthdayRepoShape {
  /** Incremental sync tombstones, and persons re-sent without a birthday. */
  readonly deleteByResourceNames: (
    accountId: string,
    resourceNames: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<GoogleBirthday>, SqlError>;
  /** Full pass: one transaction swaps the account's rows. */
  readonly replaceForAccount: (params: {
    readonly accountId: string;
    readonly birthdays: ReadonlyArray<GoogleBirthday>;
    readonly syncedAt: number;
  }) => Effect.Effect<void, SqlError>;
  readonly upsertMany: (
    birthdays: ReadonlyArray<GoogleBirthday>,
    syncedAt: number,
  ) => Effect.Effect<void, SqlError>;
}

const makeBirthdayRepo: Effect.Effect<BirthdayRepoShape, never, Reactivity | SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    const mutation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([BIRTHDAYS_KEY], effect);

    const upsertRow = (birthday: GoogleBirthday, syncedAt: number) => sql`
      INSERT INTO contact_birthdays (account_id, resource_name, display_name, month, day,
                                     year, synced_at)
      SELECT ${birthday.accountId}, ${birthday.resourceName}, ${birthday.displayName},
             ${birthday.month}, ${birthday.day}, ${birthday.year ?? null}, ${syncedAt}
      ${accountGuard(sql, birthday.accountId)}
      ON CONFLICT (account_id, resource_name) DO UPDATE SET
        display_name = excluded.display_name,
        month = excluded.month,
        day = excluded.day,
        year = excluded.year,
        synced_at = excluded.synced_at
    `;

    return {
      deleteByResourceNames: (accountId, resourceNames) =>
        resourceNames.length === 0
          ? Effect.void
          : mutation(
              Effect.forEach(
                resourceNames,
                (resourceName) =>
                  sql`DELETE FROM contact_birthdays
                      WHERE account_id = ${accountId} AND resource_name = ${resourceName}`,
                { discard: true },
              ),
            ),
      listAll: () =>
        Effect.map(
          sql<ContactBirthdayRow>`SELECT * FROM contact_birthdays
                                  ORDER BY account_id, resource_name`,
          (rows) => rows.map(googleBirthdayFromRow),
        ),
      replaceForAccount: ({ accountId, birthdays, syncedAt }) =>
        mutation(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM contact_birthdays WHERE account_id = ${accountId}`;
              yield* Effect.forEach(birthdays, (birthday) => upsertRow(birthday, syncedAt), {
                discard: true,
              });
            }),
          ),
        ),
      upsertMany: (birthdays, syncedAt) =>
        birthdays.length === 0
          ? Effect.void
          : mutation(
              Effect.forEach(birthdays, (birthday) => upsertRow(birthday, syncedAt), {
                discard: true,
              }),
            ),
    };
  });

export class BirthdayRepo extends Context.Service<BirthdayRepo, BirthdayRepoShape>()(
  'db/BirthdayRepo',
) {
  static readonly layer: Layer.Layer<BirthdayRepo, never, Reactivity | SqlClient> =
    Layer.effect(BirthdayRepo)(makeBirthdayRepo);
}
