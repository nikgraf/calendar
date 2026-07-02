import {
  EventRecord as EventRecordSchema,
  type Account,
  type CalendarInfo,
  type EventRecord,
  type PendingOp,
  type SyncState,
} from '@calendar/core';
import { Context, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { ACCOUNTS_KEY, CALENDARS_KEY, DATA_KEY, eventsKey } from './keys.ts';
import {
  accountFromRow,
  calendarFromRow,
  eventFromRow,
  eventToRow,
  pendingOpFromRow,
  syncStateFromRow,
  type AccountRow,
  type CalendarRow,
  type EventRow,
  type PendingOpRow,
  type SyncStateRow,
} from './rows.ts';

/** PendingOp payloads are stored as encoded EventRecord JSON. */
const eventPayloadJson = (event: EventRecord): unknown =>
  Schema.encodeSync(EventRecordSchema)(event);

export interface AccountRepoShape {
  readonly list: () => Effect.Effect<ReadonlyArray<Account>, SqlError>;
  readonly remove: (accountId: string) => Effect.Effect<void, SqlError>;
  readonly setStatus: (
    accountId: string,
    status: Account['status'],
  ) => Effect.Effect<void, SqlError>;
  readonly upsert: (account: Account) => Effect.Effect<void, SqlError>;
}

const makeAccountRepo: Effect.Effect<AccountRepoShape, never, Reactivity | SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity;
    const invalidating = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([ACCOUNTS_KEY, DATA_KEY], effect);

    return {
      list: () =>
        Effect.map(sql<AccountRow>`SELECT * FROM accounts ORDER BY created_at`, (rows) =>
          rows.map(accountFromRow),
        ),
      remove: (accountId) =>
        invalidating(
          Effect.gen(function* () {
            yield* sql`DELETE FROM events WHERE account_id = ${accountId}`;
            yield* sql`DELETE FROM calendars WHERE account_id = ${accountId}`;
            yield* sql`DELETE FROM pending_ops WHERE account_id = ${accountId}`;
            yield* sql`DELETE FROM sync_state WHERE account_id = ${accountId}`;
            yield* sql`DELETE FROM accounts WHERE id = ${accountId}`;
          }),
        ),
      setStatus: (accountId, status) =>
        invalidating(
          Effect.asVoid(sql`UPDATE accounts SET status = ${status} WHERE id = ${accountId}`),
        ),
      upsert: (account) =>
        invalidating(
          Effect.asVoid(sql`
          INSERT INTO accounts (id, email, display_name, avatar_url, status, created_at)
          VALUES (${account.id}, ${account.email}, ${account.displayName ?? null},
                  ${account.avatarUrl ?? null}, ${account.status}, ${account.createdAt})
          ON CONFLICT (id) DO UPDATE SET
            email = excluded.email,
            display_name = excluded.display_name,
            avatar_url = excluded.avatar_url,
            status = excluded.status
        `),
        ),
    };
  });

export class AccountRepo extends Context.Service<AccountRepo, AccountRepoShape>()(
  'db/AccountRepo',
) {
  static readonly layer: Layer.Layer<AccountRepo, never, Reactivity | SqlClient.SqlClient> =
    Layer.effect(AccountRepo)(makeAccountRepo);
}

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
  readonly setVisible: (
    accountId: string,
    calendarId: string,
    isVisible: boolean,
  ) => Effect.Effect<void, SqlError>;
  /** Upserts while preserving the local is_visible toggle on update. */
  readonly upsertMany: (calendars: ReadonlyArray<CalendarInfo>) => Effect.Effect<void, SqlError>;
}

const makeCalendarRepo: Effect.Effect<CalendarRepoShape, never, Reactivity | SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity;
    const invalidating = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([CALENDARS_KEY, DATA_KEY], effect);

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
              VALUES (${calendar.accountId}, ${calendar.id}, ${calendar.summary},
                      ${calendar.colorHex}, ${calendar.accessRole},
                      ${calendar.isPrimary ? 1 : 0}, ${calendar.isVisible ? 1 : 0},
                      ${calendar.timeZone})
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
  static readonly layer: Layer.Layer<CalendarRepo, never, Reactivity | SqlClient.SqlClient> =
    Layer.effect(CalendarRepo)(makeCalendarRepo);
}

export interface EventWindow {
  /** Recurring masters possibly intersecting the range. */
  readonly masters: ReadonlyArray<EventRecord>;
  /** Override instances of those masters (any range) keyed later by master. */
  readonly overrides: ReadonlyArray<EventRecord>;
  /** Concrete events overlapping the range (includes in-range overrides). */
  readonly singles: ReadonlyArray<EventRecord>;
}

export interface EventRepoShape {
  readonly deleteEvent: (
    accountId: string,
    calendarId: string,
    eventId: string,
  ) => Effect.Effect<void, SqlError>;
  /** Deletes synced rows of a calendar not touched at/after syncedAt. */
  readonly deleteStale: (
    accountId: string,
    calendarId: string,
    syncedAt: number,
  ) => Effect.Effect<void, SqlError>;
  readonly getById: (
    accountId: string,
    calendarId: string,
    eventId: string,
  ) => Effect.Effect<EventRecord | null, SqlError>;
  /** Window of visible-calendar events for range rendering. */
  readonly getWindow: (
    rangeStartUtc: number,
    rangeEndUtc: number,
  ) => Effect.Effect<EventWindow, SqlError>;
  readonly upsertMany: (events: ReadonlyArray<EventRecord>) => Effect.Effect<void, SqlError>;
}

const makeEventRepo: Effect.Effect<EventRepoShape, never, Reactivity | SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity;

    const upsertOne = (event: EventRecord) => {
      const row = eventToRow(event);
      return sql`
      INSERT INTO events (account_id, calendar_id, id, etag, status, title, location,
                          description, is_all_day, start_utc, end_utc, start_date,
                          end_date, start_time_zone, recurrence, recurring_event_id,
                          original_start_utc, attendees, organizer_email, sync_status,
                          updated_at, synced_at)
      VALUES (${row.account_id}, ${row.calendar_id}, ${row.id}, ${row.etag},
              ${row.status}, ${row.title}, ${row.location}, ${row.description},
              ${row.is_all_day}, ${row.start_utc}, ${row.end_utc}, ${row.start_date},
              ${row.end_date}, ${row.start_time_zone}, ${row.recurrence},
              ${row.recurring_event_id}, ${row.original_start_utc}, ${row.attendees},
              ${row.organizer_email}, ${row.sync_status}, ${row.updated_at},
              ${row.synced_at})
      ON CONFLICT (account_id, calendar_id, id) DO UPDATE SET
        etag = excluded.etag,
        status = excluded.status,
        title = excluded.title,
        location = excluded.location,
        description = excluded.description,
        is_all_day = excluded.is_all_day,
        start_utc = excluded.start_utc,
        end_utc = excluded.end_utc,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        start_time_zone = excluded.start_time_zone,
        recurrence = excluded.recurrence,
        recurring_event_id = excluded.recurring_event_id,
        original_start_utc = excluded.original_start_utc,
        attendees = excluded.attendees,
        organizer_email = excluded.organizer_email,
        sync_status = excluded.sync_status,
        updated_at = excluded.updated_at,
        synced_at = excluded.synced_at
    `;
    };

    return {
      deleteEvent: (accountId, calendarId, eventId) =>
        reactivity.mutation(
          [eventsKey(calendarId), DATA_KEY],
          Effect.asVoid(
            sql`DELETE FROM events WHERE account_id = ${accountId}
              AND calendar_id = ${calendarId} AND id = ${eventId}`,
          ),
        ),
      deleteStale: (accountId, calendarId, syncedAt) =>
        reactivity.mutation(
          [eventsKey(calendarId), DATA_KEY],
          Effect.asVoid(
            sql`DELETE FROM events WHERE account_id = ${accountId}
              AND calendar_id = ${calendarId} AND sync_status = 'synced'
              AND synced_at < ${syncedAt}`,
          ),
        ),
      getById: (accountId, calendarId, eventId) =>
        Effect.map(
          sql<EventRow>`SELECT * FROM events WHERE account_id = ${accountId}
            AND calendar_id = ${calendarId} AND id = ${eventId}`,
          (rows) => (rows[0] ? eventFromRow(rows[0]) : null),
        ),
      getWindow: (rangeStartUtc, rangeEndUtc) =>
        Effect.gen(function* () {
          const singles = yield* sql<EventRow>`
          SELECT e.* FROM events e
          JOIN calendars c ON c.account_id = e.account_id AND c.id = e.calendar_id
          WHERE c.is_visible = 1 AND e.recurrence IS NULL
          AND e.start_utc < ${rangeEndUtc} AND e.end_utc > ${rangeStartUtc}
          AND e.status != 'cancelled'`;

          const masters = yield* sql<EventRow>`
          SELECT e.* FROM events e
          JOIN calendars c ON c.account_id = e.account_id AND c.id = e.calendar_id
          WHERE c.is_visible = 1 AND e.recurrence IS NOT NULL
          AND e.start_utc < ${rangeEndUtc}
          AND e.status != 'cancelled'`;

          const masterIds = masters.map((row) => row.id);
          const overrides =
            masterIds.length === 0
              ? []
              : yield* sql<EventRow>`
                SELECT * FROM events
                WHERE recurring_event_id IN ${sql.in(masterIds)}`;

          return {
            masters: masters.map(eventFromRow),
            overrides: overrides.map(eventFromRow),
            singles: singles.map(eventFromRow),
          };
        }),
      upsertMany: (events) => {
        const keys = [...new Set(events.map((event) => eventsKey(event.calendarId))), DATA_KEY];
        return reactivity.mutation(keys, Effect.forEach(events, upsertOne, { discard: true }));
      },
    };
  });

export class EventRepo extends Context.Service<EventRepo, EventRepoShape>()('db/EventRepo') {
  static readonly layer: Layer.Layer<EventRepo, never, Reactivity | SqlClient.SqlClient> =
    Layer.effect(EventRepo)(makeEventRepo);
}

export interface PendingOpRepoShape {
  readonly enqueue: (op: PendingOp) => Effect.Effect<void, SqlError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  readonly listDue: (now: number) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  readonly markFailed: (
    opId: string,
    attempts: number,
    nextAttemptAt: number,
    lastError: string,
  ) => Effect.Effect<void, SqlError>;
  readonly remove: (opId: string) => Effect.Effect<void, SqlError>;
  readonly removeForEvent: (calendarId: string, eventId: string) => Effect.Effect<void, SqlError>;
}

const makePendingOpRepo: Effect.Effect<
  PendingOpRepoShape,
  never,
  Reactivity | SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reactivity = yield* Reactivity;

  return {
    enqueue: (op) =>
      reactivity.mutation(
        [DATA_KEY],
        Effect.asVoid(sql`
          INSERT INTO pending_ops (id, account_id, calendar_id, kind, event_id,
                                   payload, base_etag, attempts, next_attempt_at,
                                   last_error, created_at)
          VALUES (${op.id}, ${op.accountId}, ${op.calendarId}, ${op.kind},
                  ${op.eventId},
                  ${op.payload ? JSON.stringify(eventPayloadJson(op.payload)) : null},
                  ${op.baseEtag ?? null}, ${op.attempts}, ${op.nextAttemptAt},
                  ${op.lastError ?? null}, ${op.createdAt})
        `),
      ),
    listAll: () =>
      Effect.map(sql<PendingOpRow>`SELECT * FROM pending_ops ORDER BY created_at`, (rows) =>
        rows.map(pendingOpFromRow),
      ),
    listDue: (now) =>
      Effect.map(
        sql<PendingOpRow>`SELECT * FROM pending_ops
            WHERE next_attempt_at <= ${now} ORDER BY created_at`,
        (rows) => rows.map(pendingOpFromRow),
      ),
    markFailed: (opId, attempts, nextAttemptAt, lastError) =>
      Effect.asVoid(
        sql`UPDATE pending_ops SET attempts = ${attempts},
            next_attempt_at = ${nextAttemptAt}, last_error = ${lastError}
            WHERE id = ${opId}`,
      ),
    remove: (opId) => Effect.asVoid(sql`DELETE FROM pending_ops WHERE id = ${opId}`),
    removeForEvent: (calendarId, eventId) =>
      Effect.asVoid(
        sql`DELETE FROM pending_ops WHERE calendar_id = ${calendarId}
            AND event_id = ${eventId}`,
      ),
  };
});

export class PendingOpRepo extends Context.Service<PendingOpRepo, PendingOpRepoShape>()(
  'db/PendingOpRepo',
) {
  static readonly layer: Layer.Layer<PendingOpRepo, never, Reactivity | SqlClient.SqlClient> =
    Layer.effect(PendingOpRepo)(makePendingOpRepo);
}

export interface SyncStateRepoShape {
  readonly get: (accountId: string, scope: string) => Effect.Effect<SyncState | null, SqlError>;
  readonly set: (state: SyncState) => Effect.Effect<void, SqlError>;
}

const makeSyncStateRepo: Effect.Effect<SyncStateRepoShape, never, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient;
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
        VALUES (${state.accountId}, ${state.scope}, ${state.syncToken},
                ${state.lastFullSyncAt}, ${state.lastSyncAt}, ${state.status})
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
  static readonly layer: Layer.Layer<SyncStateRepo, never, SqlClient.SqlClient> =
    Layer.effect(SyncStateRepo)(makeSyncStateRepo);
}

/** All repositories, ready to sit on a SqlClient + Reactivity. */
export const reposLayer: Layer.Layer<
  AccountRepo | CalendarRepo | EventRepo | PendingOpRepo | SyncStateRepo,
  never,
  Reactivity | SqlClient.SqlClient
> = Layer.mergeAll(
  AccountRepo.layer,
  CalendarRepo.layer,
  EventRepo.layer,
  PendingOpRepo.layer,
  SyncStateRepo.layer,
);
