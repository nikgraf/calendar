import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account } from '@calendar/core';
import { app } from 'electron';
import { Context, Effect, Layer, Schema } from 'effect';

/**
 * Interim account persistence for M2 — a JSON file in userData. Replaced by
 * the SQLite accounts repository in M3.
 */
export class AccountsStore extends Context.Service<
  AccountsStore,
  {
    readonly add: (account: Account) => Effect.Effect<void>;
    readonly list: () => Effect.Effect<ReadonlyArray<Account>>;
    readonly remove: (accountId: string) => Effect.Effect<void>;
  }
>()('desktop/AccountsStore') {
  static readonly layer: Layer.Layer<AccountsStore> = Layer.sync(AccountsStore, () => {
    const path = join(app.getPath('userData'), 'accounts.json');
    const read = (): Array<Account> => {
      try {
        return Schema.decodeUnknownSync(Schema.Array(Account))(
          JSON.parse(readFileSync(path, 'utf8')),
        ) as Array<Account>;
      } catch {
        return [];
      }
    };
    const write = (accounts: ReadonlyArray<Account>): void => {
      writeFileSync(path, JSON.stringify(Schema.encodeSync(Schema.Array(Account))(accounts)));
    };
    return {
      add: (account) =>
        Effect.sync(() => {
          write([...read().filter((a) => a.email !== account.email), account]);
        }),
      list: () => Effect.sync(() => read()),
      remove: (accountId) =>
        Effect.sync(() => {
          write(read().filter((a) => a.id !== accountId));
        }),
    };
  });
}
