import { type SyncState } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { syncStateFromRow, type SyncStateRow } from './rows.ts';
import { accountGuard } from './repoShared.ts';

export interface SyncStateRepoShape {
  readonly get: (accountId: string, scope: string) => Effect.Effect<SyncState | null, SqlError>;
  readonly set: (state: SyncState) => Effect.Effect<void, SqlError>;
}

const makeSyncStateRepo: Effect.Effect<SyncStateRepoShape, never, SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient;
    return {
      get: (accountId, scope) =>
        Effect.map(
          sql<SyncStateRow>`SELECT * FROM sync_state
            WHERE account_id = ${accountId} AND scope = ${scope}`,
          (rows) => (rows[0] ? syncStateFromRow(rows[0]) : null),
        ),
      set: (state) =>
        Effect.asVoid(sql`
        INSERT INTO sync_state (account_id, scope, sync_token, last_full_sync_at,
                                last_sync_at, status)
        SELECT ${state.accountId}, ${state.scope}, ${state.syncToken},
               ${state.lastFullSyncAt}, ${state.lastSyncAt}, ${state.status}
        ${accountGuard(sql, state.accountId)}
        ON CONFLICT (account_id, scope) DO UPDATE SET
          sync_token = excluded.sync_token,
          last_full_sync_at = excluded.last_full_sync_at,
          last_sync_at = excluded.last_sync_at,
          status = excluded.status
      `),
    };
  },
);

export class SyncStateRepo extends Context.Service<SyncStateRepo, SyncStateRepoShape>()(
  'db/SyncStateRepo',
) {
  static readonly layer: Layer.Layer<SyncStateRepo, never, SqlClient> =
    Layer.effect(SyncStateRepo)(makeSyncStateRepo);
}
