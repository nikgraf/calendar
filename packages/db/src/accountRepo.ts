import { type Account } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { ACCOUNTS_KEY, BIRTHDAYS_KEY } from './keys.ts';
import { accountFromRow, type AccountRow } from './rows.ts';

export interface AccountRepoShape {
  readonly get: (accountId: string) => Effect.Effect<Account | undefined, SqlError>;
  readonly list: () => Effect.Effect<ReadonlyArray<Account>, SqlError>;
  readonly remove: (accountId: string) => Effect.Effect<void, SqlError>;
  /** Flipped off when a People call reports the scopes were never granted. */
  readonly setContactsEnabled: (
    accountId: string,
    enabled: boolean,
  ) => Effect.Effect<void, SqlError>;
  readonly setStatus: (
    accountId: string,
    status: Account['status'],
  ) => Effect.Effect<void, SqlError>;
  /** Flipped off when a tasks call reports the scope was never granted. */
  readonly setTasksEnabled: (accountId: string, enabled: boolean) => Effect.Effect<void, SqlError>;
  readonly upsert: (account: Account) => Effect.Effect<void, SqlError>;
}

const makeAccountRepo: Effect.Effect<AccountRepoShape, never, Reactivity | SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    const invalidating = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([ACCOUNTS_KEY], effect);

    return {
      get: (accountId) =>
        Effect.map(sql<AccountRow>`SELECT * FROM accounts WHERE id = ${accountId}`, (rows) =>
          rows[0] ? accountFromRow(rows[0]) : undefined,
        ),
      list: () =>
        Effect.map(sql<AccountRow>`SELECT * FROM accounts ORDER BY created_at`, (rows) =>
          rows.map(accountFromRow),
        ),
      // One transaction: a sync pass finishing meanwhile sees either the
      // whole account or none of it — and its row writes are guarded on
      // the account row (see accountGuard), so nothing comes back.
      remove: (accountId) =>
        reactivity.mutation(
          [ACCOUNTS_KEY, BIRTHDAYS_KEY],
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM events WHERE account_id = ${accountId}`;
              yield* sql`DELETE FROM contacts WHERE account_id = ${accountId}`;
              yield* sql`DELETE FROM contact_birthdays WHERE account_id = ${accountId}`;
              yield* sql`DELETE FROM tasks WHERE account_id = ${accountId}`;
              yield* sql`DELETE FROM task_lists WHERE account_id = ${accountId}`;
              yield* sql`DELETE FROM calendars WHERE account_id = ${accountId}`;
              yield* sql`DELETE FROM pending_ops WHERE account_id = ${accountId}`;
              yield* sql`DELETE FROM sync_state WHERE account_id = ${accountId}`;
              yield* sql`DELETE FROM accounts WHERE id = ${accountId}`;
            }),
          ),
        ),
      setContactsEnabled: (accountId, enabled) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE accounts SET contacts_enabled = ${enabled ? 1 : 0} WHERE id = ${accountId}`,
          ),
        ),
      setStatus: (accountId, status) =>
        invalidating(
          Effect.asVoid(sql`UPDATE accounts SET status = ${status} WHERE id = ${accountId}`),
        ),
      setTasksEnabled: (accountId, enabled) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE accounts SET tasks_enabled = ${enabled ? 1 : 0} WHERE id = ${accountId}`,
          ),
        ),
      upsert: (account) =>
        invalidating(
          Effect.asVoid(sql`
          INSERT INTO accounts (id, email, display_name, avatar_url, status, created_at,
                                tasks_enabled, provider, contacts_enabled)
          VALUES (${account.id}, ${account.email}, ${account.displayName ?? null},
                  ${account.avatarUrl ?? null}, ${account.status}, ${account.createdAt},
                  ${account.tasksEnabled ? 1 : 0}, ${account.provider},
                  ${account.contactsEnabled ? 1 : 0})
          ON CONFLICT (id) DO UPDATE SET
            email = excluded.email,
            display_name = excluded.display_name,
            avatar_url = excluded.avatar_url,
            status = excluded.status,
            tasks_enabled = excluded.tasks_enabled,
            provider = excluded.provider,
            contacts_enabled = excluded.contacts_enabled
        `),
        ),
    };
  },
);

export class AccountRepo extends Context.Service<AccountRepo, AccountRepoShape>()(
  'db/AccountRepo',
) {
  static readonly layer: Layer.Layer<AccountRepo, never, Reactivity | SqlClient> =
    Layer.effect(AccountRepo)(makeAccountRepo);
}
