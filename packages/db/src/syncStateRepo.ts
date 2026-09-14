import { type SyncState } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { SYNC_STATE_KEY } from './keys.ts';
import { syncStateFromRow, type SyncStateRow } from './rows.ts';
import { accountGuard } from './repoShared.ts';

/** Per account: how many event calendars are still on their first full list. */
export interface EventsSyncSummary {
  readonly accountId: string;
  readonly importing: number;
}

export interface SyncStateRepoShape {
  readonly get: (accountId: string, scope: string) => Effect.Effect<SyncState | null, SqlError>;
  /** Forgets a scope — a calendar's row when the calendar vanished upstream. */
  readonly remove: (accountId: string, scope: string) => Effect.Effect<void, SqlError>;
  readonly set: (state: SyncState) => Effect.Effect<void, SqlError>;
  /**
   * Calendars whose history is still being listed: no token yet (first
   * pass, or after a 410) or a pass marked 'syncing'. Only calendars that
   * still exist count — a leftover row cannot pin the line forever. Feeds
   * the Settings "Importing history…" line.
   */
  readonly summarizeEvents: () => Effect.Effect<ReadonlyArray<EventsSyncSummary>, SqlError>;
}

interface SummaryRow {
  readonly account_id: string;
  readonly importing: number;
}

const makeSyncStateRepo: Effect.Effect<SyncStateRepoShape, never, Reactivity | SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    return {
      get: (accountId, scope) =>
        Effect.map(
          sql<SyncStateRow>`SELECT * FROM sync_state
            WHERE account_id = ${accountId} AND scope = ${scope}`,
          (rows) => (rows[0] ? syncStateFromRow(rows[0]) : null),
        ),
      remove: (accountId, scope) =>
        reactivity.mutation(
          [SYNC_STATE_KEY],
          Effect.asVoid(
            sql`DELETE FROM sync_state WHERE account_id = ${accountId} AND scope = ${scope}`,
          ),
        ),
      set: (state) =>
        reactivity.mutation(
          [SYNC_STATE_KEY],
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
        ),
      summarizeEvents: () =>
        Effect.map(
          sql<SummaryRow>`
            SELECT s.account_id,
                   SUM(s.sync_token IS NULL OR s.status = 'syncing') AS importing
            FROM sync_state s
            JOIN calendars c ON c.account_id = s.account_id AND s.scope = 'events:' || c.id
            GROUP BY s.account_id ORDER BY s.account_id`,
          (rows) => rows.map((row) => ({ accountId: row.account_id, importing: row.importing })),
        ),
    };
  });

export class SyncStateRepo extends Context.Service<SyncStateRepo, SyncStateRepoShape>()(
  'db/SyncStateRepo',
) {
  static readonly layer: Layer.Layer<SyncStateRepo, never, Reactivity | SqlClient> =
    Layer.effect(SyncStateRepo)(makeSyncStateRepo);
}
