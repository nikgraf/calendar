import { type CalendarInfo } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { CALENDARS_KEY, EVENTS_KEY, SYNC_STATE_KEY } from './keys.ts';
import { calendarFromRow, type CalendarRow } from './rows.ts';
import { accountGuard } from './repoShared.ts';

export interface CalendarRepoShape {
  readonly list: (accountId?: string) => Effect.Effect<ReadonlyArray<CalendarInfo>, SqlError>;
  /**
   * Calendars gone upstream: their rows, their events and their events
   * sync state go in one transaction. Partial deletion would leave a
   * stale token behind with no calendar row left to retry the cleanup —
   * a calendar that came back would then resume incrementally onto an
   * empty cache and never re-list its history.
   */
  readonly purge: (accountId: string, ids: ReadonlyArray<string>) => Effect.Effect<void, SqlError>;
  readonly removeByIds: (
    accountId: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  /** Deletes calendars of the account that are not in keepIds. */
  readonly removeMissing: (
    accountId: string,
    keepIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  readonly setColor: (
    accountId: string,
    calendarId: string,
    colorHex: string,
  ) => Effect.Effect<void, SqlError>;
  readonly setVisible: (
    accountId: string,
    calendarId: string,
    isVisible: boolean,
  ) => Effect.Effect<void, SqlError>;
  /** Upserts while preserving the local is_visible toggle on update. */
  readonly upsertMany: (calendars: ReadonlyArray<CalendarInfo>) => Effect.Effect<void, SqlError>;
}

const makeCalendarRepo: Effect.Effect<CalendarRepoShape, never, Reactivity | SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    const invalidating = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([CALENDARS_KEY], effect);
    // Changes that alter which events a window returns (getWindow joins on
    // is_visible and on the calendar row itself) also invalidate events, so
    // the UI's range atoms need not watch CALENDARS_KEY.
    const invalidatingEvents = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([CALENDARS_KEY, EVENTS_KEY], effect);

    return {
      // The provider is the owning account's, joined rather than stored so
      // it can never drift from accounts.provider.
      list: (accountId) =>
        Effect.map(
          accountId === undefined
            ? sql<CalendarRow>`SELECT c.*, a.provider AS account_provider
                FROM calendars c LEFT JOIN accounts a ON a.id = c.account_id
                ORDER BY c.account_id, c.summary`
            : sql<CalendarRow>`SELECT c.*, a.provider AS account_provider
                FROM calendars c LEFT JOIN accounts a ON a.id = c.account_id
                WHERE c.account_id = ${accountId} ORDER BY c.summary`,
          (rows) => rows.map(calendarFromRow),
        ),
      purge: (accountId, ids) =>
        ids.length === 0
          ? Effect.void
          : reactivity.mutation(
              [CALENDARS_KEY, EVENTS_KEY, SYNC_STATE_KEY],
              sql.withTransaction(
                Effect.forEach(
                  ids,
                  (id) =>
                    Effect.gen(function* () {
                      yield* sql`DELETE FROM events
                        WHERE account_id = ${accountId} AND calendar_id = ${id}`;
                      yield* sql`DELETE FROM sync_state
                        WHERE account_id = ${accountId} AND scope = ${`events:${id}`}`;
                      yield* sql`DELETE FROM calendars
                        WHERE account_id = ${accountId} AND id = ${id}`;
                    }),
                  { discard: true },
                ),
              ),
            ),
      removeByIds: (accountId, ids) =>
        ids.length === 0
          ? Effect.void
          : invalidatingEvents(
              Effect.asVoid(
                sql`DELETE FROM calendars WHERE account_id = ${accountId}
                  AND id IN ${sql.in(ids)}`,
              ),
            ),
      removeMissing: (accountId, keepIds) =>
        invalidatingEvents(
          Effect.asVoid(
            keepIds.length === 0
              ? sql`DELETE FROM calendars WHERE account_id = ${accountId}`
              : sql`DELETE FROM calendars WHERE account_id = ${accountId}
                  AND id NOT IN ${sql.in(keepIds)}`,
          ),
        ),
      setColor: (accountId, calendarId, colorHex) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE calendars SET color_hex = ${colorHex}
              WHERE account_id = ${accountId} AND id = ${calendarId}`,
          ),
        ),
      setVisible: (accountId, calendarId, isVisible) =>
        invalidatingEvents(
          Effect.asVoid(
            sql`UPDATE calendars SET is_visible = ${isVisible ? 1 : 0}
              WHERE account_id = ${accountId} AND id = ${calendarId}`,
          ),
        ),
      upsertMany: (calendars) =>
        invalidating(
          Effect.forEach(
            calendars,
            (calendar) =>
              sql`
              INSERT INTO calendars (account_id, id, summary, color_hex, access_role,
                                     is_primary, is_visible, time_zone, source_title)
              SELECT ${calendar.accountId}, ${calendar.id}, ${calendar.summary},
                     ${calendar.colorHex}, ${calendar.accessRole},
                     ${calendar.isPrimary ? 1 : 0}, ${calendar.isVisible ? 1 : 0},
                     ${calendar.timeZone}, ${calendar.sourceTitle ?? null}
              ${accountGuard(sql, calendar.accountId)}
              ON CONFLICT (account_id, id) DO UPDATE SET
                summary = excluded.summary,
                color_hex = excluded.color_hex,
                access_role = excluded.access_role,
                is_primary = excluded.is_primary,
                time_zone = excluded.time_zone,
                source_title = excluded.source_title
            `,
            { discard: true },
          ),
        ),
    };
  });

export class CalendarRepo extends Context.Service<CalendarRepo, CalendarRepoShape>()(
  'db/CalendarRepo',
) {
  static readonly layer: Layer.Layer<CalendarRepo, never, Reactivity | SqlClient> =
    Layer.effect(CalendarRepo)(makeCalendarRepo);
}
