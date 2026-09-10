import { type CalendarInfo } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { CALENDARS_KEY } from './keys.ts';
import { calendarFromRow, type CalendarRow } from './rows.ts';
import { accountGuard } from './repoShared.ts';

export interface CalendarRepoShape {
  readonly list: (accountId?: string) => Effect.Effect<ReadonlyArray<CalendarInfo>, SqlError>;
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

    return {
      list: (accountId) =>
        Effect.map(
          accountId === undefined
            ? sql<CalendarRow>`SELECT * FROM calendars ORDER BY account_id, summary`
            : sql<CalendarRow>`SELECT * FROM calendars WHERE account_id = ${accountId} ORDER BY summary`,
          (rows) => rows.map(calendarFromRow),
        ),
      removeByIds: (accountId, ids) =>
        ids.length === 0
          ? Effect.void
          : invalidating(
              Effect.asVoid(
                sql`DELETE FROM calendars WHERE account_id = ${accountId}
                  AND id IN ${sql.in(ids)}`,
              ),
            ),
      removeMissing: (accountId, keepIds) =>
        invalidating(
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
        invalidating(
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
                                     is_primary, is_visible, time_zone)
              SELECT ${calendar.accountId}, ${calendar.id}, ${calendar.summary},
                     ${calendar.colorHex}, ${calendar.accessRole},
                     ${calendar.isPrimary ? 1 : 0}, ${calendar.isVisible ? 1 : 0},
                     ${calendar.timeZone}
              ${accountGuard(sql, calendar.accountId)}
              ON CONFLICT (account_id, id) DO UPDATE SET
                summary = excluded.summary,
                color_hex = excluded.color_hex,
                access_role = excluded.access_role,
                is_primary = excluded.is_primary,
                time_zone = excluded.time_zone
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
