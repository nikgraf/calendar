import {
  type Account,
  type CalendarInfo,
  type EventRecord,
  EventRecord as EventRecordSchema,
  type PendingOp,
  type SyncState,
  TaskListInfo,
  TaskRecord,
} from '@calendar/core';
import { Context, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import {
  ACCOUNTS_KEY,
  CALENDARS_KEY,
  EVENTS_KEY,
  eventsKey,
  OPS_KEY,
  TASKLISTS_KEY,
  TASKS_KEY,
} from './keys.ts';
import {
  accountFromRow,
  calendarFromRow,
  eventFromRow,
  eventToRow,
  pendingOpFromRow,
  syncStateFromRow,
  taskFromRow,
  taskJsonColumns,
  taskListFromRow,
  type AccountRow,
  type CalendarRow,
  type EventRow,
  type PendingOpRow,
  type SyncStateRow,
  type TaskListRow,
  type TaskRow,
} from './rows.ts';

/** PendingOp payloads are stored as encoded EventRecord JSON. */
const eventPayloadJson = (event: EventRecord): unknown =>
  Schema.encodeSync(EventRecordSchema)(event);

export interface AccountRepoShape {
  readonly get: (accountId: string) => Effect.Effect<Account | undefined, SqlError>;
  readonly list: () => Effect.Effect<ReadonlyArray<Account>, SqlError>;
  readonly remove: (accountId: string) => Effect.Effect<void, SqlError>;
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
      remove: (accountId) =>
        invalidating(
          Effect.gen(function* () {
            yield* sql`DELETE FROM events WHERE account_id = ${accountId}`;
            yield* sql`DELETE FROM tasks WHERE account_id = ${accountId}`;
            yield* sql`DELETE FROM task_lists WHERE account_id = ${accountId}`;
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
                                tasks_enabled, provider)
          VALUES (${account.id}, ${account.email}, ${account.displayName ?? null},
                  ${account.avatarUrl ?? null}, ${account.status}, ${account.createdAt},
                  ${account.tasksEnabled ? 1 : 0}, ${account.provider})
          ON CONFLICT (id) DO UPDATE SET
            email = excluded.email,
            display_name = excluded.display_name,
            avatar_url = excluded.avatar_url,
            status = excluded.status,
            tasks_enabled = excluded.tasks_enabled,
            provider = excluded.provider
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
  static readonly layer: Layer.Layer<CalendarRepo, never, Reactivity | SqlClient> =
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
  /** Exception rows belonging to a recurring master. */
  readonly listOverrides: (
    accountId: string,
    calendarId: string,
    masterId: string,
  ) => Effect.Effect<ReadonlyArray<EventRecord>, SqlError>;
  readonly upsertMany: (events: ReadonlyArray<EventRecord>) => Effect.Effect<void, SqlError>;
}

const makeEventRepo: Effect.Effect<EventRepoShape, never, Reactivity | SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient;
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
          [EVENTS_KEY, eventsKey(calendarId)],
          Effect.asVoid(
            sql`DELETE FROM events WHERE account_id = ${accountId}
              AND calendar_id = ${calendarId} AND id = ${eventId}`,
          ),
        ),
      deleteStale: (accountId, calendarId, syncedAt) =>
        reactivity.mutation(
          [EVENTS_KEY, eventsKey(calendarId)],
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
      listOverrides: (accountId, calendarId, masterId) =>
        Effect.map(
          sql<EventRow>`SELECT * FROM events WHERE account_id = ${accountId}
            AND calendar_id = ${calendarId} AND recurring_event_id = ${masterId}`,
          (rows) => rows.map(eventFromRow),
        ),
      upsertMany: (events) => {
        const keys = [EVENTS_KEY, ...new Set(events.map((event) => eventsKey(event.calendarId)))];
        return reactivity.mutation(keys, Effect.forEach(events, upsertOne, { discard: true }));
      },
    };
  },
);

export class EventRepo extends Context.Service<EventRepo, EventRepoShape>()('db/EventRepo') {
  static readonly layer: Layer.Layer<EventRepo, never, Reactivity | SqlClient> =
    Layer.effect(EventRepo)(makeEventRepo);
}

export interface PendingOpRepoShape {
  readonly enqueue: (op: PendingOp) => Effect.Effect<void, SqlError>;
  readonly getById: (opId: string) => Effect.Effect<PendingOp | undefined, SqlError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  readonly listDue: (now: number) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  /** Persists the pre-network stamp for non-idempotent calls. */
  readonly markDispatched: (opId: string, at: number) => Effect.Effect<void, SqlError>;
  readonly markFailed: (
    opId: string,
    attempts: number,
    nextAttemptAt: number,
    lastError: string,
  ) => Effect.Effect<void, SqlError>;
  readonly remove: (opId: string) => Effect.Effect<void, SqlError>;
  readonly removeForEvent: (calendarId: string, eventId: string) => Effect.Effect<void, SqlError>;
  /** Re-keys queued ops after a server-assigned id replaces a temp id. */
  readonly rewriteEventId: (
    accountId: string,
    calendarId: string,
    oldEventId: string,
    newEventId: string,
  ) => Effect.Effect<void, SqlError>;
}

const makePendingOpRepo: Effect.Effect<PendingOpRepoShape, never, Reactivity | SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    const invalidating = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([OPS_KEY], effect);

    return {
      enqueue: (op) =>
        invalidating(
          Effect.asVoid(sql`
          INSERT INTO pending_ops (id, account_id, calendar_id, kind, event_id,
                                   payload, base_etag, attempts, next_attempt_at,
                                   last_error, created_at, color_hex,
                                   task_list_id, task_status,
                                   task_title, task_notes, task_due, dispatched_at)
          VALUES (${op.id}, ${op.accountId}, ${op.calendarId}, ${op.kind},
                  ${op.eventId},
                  ${op.payload ? JSON.stringify(eventPayloadJson(op.payload)) : null},
                  ${op.baseEtag ?? null}, ${op.attempts}, ${op.nextAttemptAt},
                  ${op.lastError ?? null}, ${op.createdAt}, ${op.colorHex ?? null},
                  ${op.taskListId ?? null}, ${op.taskStatus ?? null},
                  ${op.taskTitle ?? null}, ${op.taskNotes ?? null}, ${op.taskDue ?? null},
                  ${op.dispatchedAt ?? null})
        `),
        ),
      getById: (opId) =>
        Effect.map(sql<PendingOpRow>`SELECT * FROM pending_ops WHERE id = ${opId}`, (rows) =>
          rows[0] ? pendingOpFromRow(rows[0]) : undefined,
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
      markDispatched: (opId, at) =>
        invalidating(
          Effect.asVoid(sql`UPDATE pending_ops SET dispatched_at = ${at} WHERE id = ${opId}`),
        ),
      markFailed: (opId, attempts, nextAttemptAt, lastError) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET attempts = ${attempts},
              next_attempt_at = ${nextAttemptAt}, last_error = ${lastError}
              WHERE id = ${opId}`,
          ),
        ),
      remove: (opId) =>
        invalidating(Effect.asVoid(sql`DELETE FROM pending_ops WHERE id = ${opId}`)),
      // RSVP ops survive content-edit coalescing; stray ones resolve as
      // no-ops through the NotFound path after a delete.
      removeForEvent: (calendarId, eventId) =>
        invalidating(
          Effect.asVoid(
            sql`DELETE FROM pending_ops WHERE calendar_id = ${calendarId}
              AND event_id = ${eventId} AND kind != 'rsvp'`,
          ),
        ),
      rewriteEventId: (accountId, calendarId, oldEventId, newEventId) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET event_id = ${newEventId}
              WHERE account_id = ${accountId} AND calendar_id = ${calendarId}
                AND event_id = ${oldEventId}`,
          ),
        ),
    };
  });

export class PendingOpRepo extends Context.Service<PendingOpRepo, PendingOpRepoShape>()(
  'db/PendingOpRepo',
) {
  static readonly layer: Layer.Layer<PendingOpRepo, never, Reactivity | SqlClient> =
    Layer.effect(PendingOpRepo)(makePendingOpRepo);
}

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
  static readonly layer: Layer.Layer<SyncStateRepo, never, SqlClient> =
    Layer.effect(SyncStateRepo)(makeSyncStateRepo);
}

export interface TaskRepoShape {
  /** Deletes synced tasks of the list not touched since syncedAt (full pass). */
  readonly deleteStale: (
    accountId: string,
    listId: string,
    syncedAt: number,
  ) => Effect.Effect<void, SqlError>;
  /** Tasks with a due day inside [startDate, endDate], visible lists only. */
  readonly getWindow: (
    startDate: string,
    endDate: string,
  ) => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>;
  /** Optimistic local create (sync_status 'pending' until the push lands). */
  readonly insertLocal: (task: TaskRecord) => Effect.Effect<void, SqlError>;
  readonly listLists: (accountId?: string) => Effect.Effect<ReadonlyArray<TaskListInfo>, SqlError>;
  readonly removeListsMissing: (
    accountId: string,
    keepIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  readonly removeTask: (
    accountId: string,
    listId: string,
    taskId: string,
  ) => Effect.Effect<void, SqlError>;
  readonly removeTasksByIds: (
    accountId: string,
    listId: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  /** Swaps a temp id for the server-assigned one after createTask pushes. */
  readonly replaceId: (
    accountId: string,
    listId: string,
    tempId: string,
    serverId: string,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Apple mirror reconciliation, one transaction, one invalidation: lists
   * upserted (local visibility kept) and pruned; every snapshot (list, id)
   * staged in a temp table (row by row — iOS's SQLite may cap bound
   * variables at 999); `changed` rows upserted only when strictly newer
   * than what is stored (a write-through that landed after the fetch
   * wins); rows absent from the snapshot deleted, but only when older than
   * `syncedAt` (a row a concurrent mutation just mirrored is newer and
   * survives). `needsFull` reports a snapshot id with no row and no
   * changed entry — the caller repeats without `changedSince`.
   */
  readonly replaceMirror: (params: {
    readonly accountId: string;
    readonly changed: ReadonlyArray<TaskRecord>;
    readonly ids: ReadonlyArray<{ readonly id: string; readonly listId: string }>;
    readonly lists: ReadonlyArray<TaskListInfo>;
    readonly syncedAt: number;
  }) => Effect.Effect<{ readonly needsFull: boolean }, SqlError>;
  readonly setListVisible: (
    accountId: string,
    listId: string,
    isVisible: boolean,
  ) => Effect.Effect<void, SqlError>;
  /** Optimistic completion toggle; the response upsert self-heals later. */
  readonly setStatus: (params: {
    readonly accountId: string;
    readonly completedAt: number | undefined;
    readonly listId: string;
    readonly status: TaskRecord['status'];
    readonly taskId: string;
  }) => Effect.Effect<void, SqlError>;
  /**
   * Optimistic edit. `undefined` leaves a field alone; `null` clears the
   * Reminders-only fields; `listId` in changes moves the row (Reminders).
   */
  readonly updateLocal: (params: {
    readonly accountId: string;
    readonly changes: {
      readonly alarms?: ReadonlyArray<number> | null | undefined;
      readonly dueDate?: string | undefined;
      readonly dueTime?: string | null | undefined;
      readonly listId?: string | undefined;
      readonly notes?: string | undefined;
      readonly priority?: TaskRecord['priority'] | null | undefined;
      readonly recurrence?: TaskRecord['recurrence'] | null | undefined;
      readonly title?: string | undefined;
      readonly url?: string | null | undefined;
    };
    readonly listId: string;
    readonly taskId: string;
  }) => Effect.Effect<void, SqlError>;
  /** Upserts while preserving the local is_visible toggle on update. */
  readonly upsertLists: (
    lists: ReadonlyArray<TaskListInfo>,
    syncedAt: number,
  ) => Effect.Effect<void, SqlError>;
  readonly upsertTasks: (
    tasks: ReadonlyArray<TaskRecord>,
    syncedAt: number,
  ) => Effect.Effect<void, SqlError>;
}

const makeTaskRepo: Effect.Effect<TaskRepoShape, never, Reactivity | SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    const tasksMutation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([TASKS_KEY], effect);
    const listsMutation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([TASKLISTS_KEY, TASKS_KEY], effect);

    /** One task row upsert; `newerOnly` adds the write-through guard. */
    const upsertTaskRow = (task: TaskRecord, syncedAt: number, newerOnly: boolean) => {
      const json = taskJsonColumns(task);
      const guard = newerOnly ? sql`WHERE excluded.updated_at > tasks.updated_at` : sql``;
      return sql`
              INSERT INTO tasks (account_id, list_id, id, title, notes, status, due_date,
                                 completed_at, web_view_link, updated_at, synced_at,
                                 sync_status, due_time, priority, url, alarms, recurrence)
              VALUES (${task.accountId}, ${task.listId}, ${task.id}, ${task.title},
                      ${task.notes ?? null}, ${task.status}, ${task.dueDate ?? null},
                      ${task.completedAt ?? null}, ${task.webViewLink ?? null},
                      ${task.updatedAt}, ${syncedAt}, 'synced',
                      ${task.dueTime ?? null}, ${task.priority ?? null}, ${task.url ?? null},
                      ${json.alarms}, ${json.recurrence})
              ON CONFLICT (account_id, list_id, id) DO UPDATE SET
                sync_status = 'synced',
                title = excluded.title,
                notes = excluded.notes,
                status = excluded.status,
                due_date = excluded.due_date,
                completed_at = excluded.completed_at,
                web_view_link = excluded.web_view_link,
                updated_at = excluded.updated_at,
                synced_at = excluded.synced_at,
                due_time = excluded.due_time,
                priority = excluded.priority,
                url = excluded.url,
                alarms = excluded.alarms,
                recurrence = excluded.recurrence
              ${guard}`;
    };

    const upsertListRow = (list: TaskListInfo, syncedAt: number) => sql`
              INSERT INTO task_lists (account_id, id, title, is_visible, synced_at, provider,
                                      color_hex)
              VALUES (${list.accountId}, ${list.id}, ${list.title},
                      ${list.isVisible ? 1 : 0}, ${syncedAt}, ${list.provider},
                      ${list.colorHex ?? null})
              ON CONFLICT (account_id, id) DO UPDATE SET
                title = excluded.title,
                synced_at = excluded.synced_at,
                provider = excluded.provider,
                color_hex = excluded.color_hex`;

    return {
      deleteStale: (accountId, listId, syncedAt) =>
        tasksMutation(
          Effect.asVoid(
            sql`DELETE FROM tasks WHERE account_id = ${accountId}
              AND list_id = ${listId} AND synced_at < ${syncedAt}
              AND sync_status = 'synced'`,
          ),
        ),
      getWindow: (startDate, endDate) =>
        Effect.map(
          sql<TaskRow>`
            SELECT t.*, l.provider AS list_provider FROM tasks t
            JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
            WHERE l.is_visible = 1
              AND t.due_date IS NOT NULL
              AND t.due_date >= ${startDate} AND t.due_date <= ${endDate}
            ORDER BY t.due_date, t.due_time IS NULL, t.due_time, t.title`,
          (rows) => rows.map(taskFromRow),
        ),
      insertLocal: (task) =>
        tasksMutation(
          Effect.asVoid(
            sql`
            INSERT INTO tasks (account_id, list_id, id, title, notes, status, due_date,
                               completed_at, web_view_link, updated_at, synced_at, sync_status,
                               due_time, priority, url, alarms, recurrence)
            VALUES (${task.accountId}, ${task.listId}, ${task.id}, ${task.title},
                    ${task.notes ?? null}, ${task.status}, ${task.dueDate ?? null},
                    ${task.completedAt ?? null}, ${task.webViewLink ?? null},
                    ${task.updatedAt}, ${task.updatedAt}, 'pending',
                    ${task.dueTime ?? null}, ${task.priority ?? null}, ${task.url ?? null},
                    ${taskJsonColumns(task).alarms}, ${taskJsonColumns(task).recurrence})`,
          ),
        ),
      listLists: (accountId) =>
        Effect.map(
          accountId === undefined
            ? sql<TaskListRow>`SELECT * FROM task_lists ORDER BY account_id, title`
            : sql<TaskListRow>`SELECT * FROM task_lists WHERE account_id = ${accountId} ORDER BY title`,
          (rows) => rows.map(taskListFromRow),
        ),

      removeListsMissing: (accountId, keepIds) =>
        listsMutation(
          Effect.gen(function* () {
            if (keepIds.length === 0) {
              yield* sql`DELETE FROM tasks WHERE account_id = ${accountId}`;
              yield* sql`DELETE FROM task_lists WHERE account_id = ${accountId}`;
              return;
            }
            yield* sql`DELETE FROM tasks WHERE account_id = ${accountId}
              AND list_id NOT IN ${sql.in(keepIds)}`;
            yield* sql`DELETE FROM task_lists WHERE account_id = ${accountId}
              AND id NOT IN ${sql.in(keepIds)}`;
          }),
        ),

      removeTask: (accountId, listId, taskId) =>
        tasksMutation(
          Effect.asVoid(
            sql`DELETE FROM tasks WHERE account_id = ${accountId}
              AND list_id = ${listId} AND id = ${taskId}`,
          ),
        ),
      removeTasksByIds: (accountId, listId, ids) =>
        ids.length === 0
          ? Effect.void
          : tasksMutation(
              Effect.asVoid(
                sql`DELETE FROM tasks WHERE account_id = ${accountId}
                  AND list_id = ${listId} AND id IN ${sql.in(ids)}`,
              ),
            ),
      replaceId: (accountId, listId, tempId, serverId) =>
        tasksMutation(
          Effect.asVoid(
            sql`UPDATE tasks SET id = ${serverId}, sync_status = 'synced'
              WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${tempId}`,
          ),
        ),
      replaceMirror: ({ accountId, changed, ids, lists, syncedAt }) =>
        listsMutation(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* Effect.forEach(lists, (list) => upsertListRow(list, syncedAt), {
                discard: true,
              });
              const listIds = lists.map((list) => list.id);
              if (listIds.length === 0) {
                yield* sql`DELETE FROM tasks WHERE account_id = ${accountId}`;
                yield* sql`DELETE FROM task_lists WHERE account_id = ${accountId}`;
              } else {
                yield* sql`DELETE FROM tasks WHERE account_id = ${accountId}
                  AND list_id NOT IN ${sql.in(listIds)}`;
                yield* sql`DELETE FROM task_lists WHERE account_id = ${accountId}
                  AND id NOT IN ${sql.in(listIds)}`;
              }
              yield* sql`CREATE TEMP TABLE IF NOT EXISTS mirror_snapshot (
                list_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (list_id, id))`;
              yield* sql`DELETE FROM mirror_snapshot`;
              // Row by row inside the transaction: no statement ever carries
              // more than a couple of bound variables.
              yield* Effect.forEach(
                ids,
                (entry) =>
                  sql`INSERT OR IGNORE INTO mirror_snapshot (list_id, id)
                    VALUES (${entry.listId}, ${entry.id})`,
                { discard: true },
              );
              yield* Effect.forEach(changed, (task) => upsertTaskRow(task, syncedAt, true), {
                discard: true,
              });
              yield* sql`DELETE FROM tasks WHERE account_id = ${accountId}
                AND synced_at < ${syncedAt}
                AND NOT EXISTS (SELECT 1 FROM mirror_snapshot s
                                WHERE s.list_id = tasks.list_id AND s.id = tasks.id)`;
              const missing = yield* sql<{ n: number }>`
                SELECT COUNT(*) AS n FROM mirror_snapshot s
                WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.account_id = ${accountId}
                                  AND t.list_id = s.list_id AND t.id = s.id)`;
              return { needsFull: (missing[0]?.n ?? 0) > 0 };
            }),
          ),
        ),
      setListVisible: (accountId, listId, isVisible) =>
        listsMutation(
          Effect.asVoid(
            sql`UPDATE task_lists SET is_visible = ${isVisible ? 1 : 0}
              WHERE account_id = ${accountId} AND id = ${listId}`,
          ),
        ),
      setStatus: ({ accountId, completedAt, listId, status, taskId }) =>
        tasksMutation(
          Effect.asVoid(
            sql`UPDATE tasks SET status = ${status}, completed_at = ${completedAt ?? null}
              WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`,
          ),
        ),
      updateLocal: ({ accountId, changes, listId, taskId }) =>
        tasksMutation(
          Effect.gen(function* () {
            if (changes.title !== undefined) {
              yield* sql`UPDATE tasks SET title = ${changes.title}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
            if (changes.notes !== undefined) {
              yield* sql`UPDATE tasks SET notes = ${changes.notes}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
            if (changes.dueDate !== undefined) {
              yield* sql`UPDATE tasks SET due_date = ${changes.dueDate}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
            if (changes.dueTime !== undefined) {
              yield* sql`UPDATE tasks SET due_time = ${changes.dueTime}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
            if (changes.priority !== undefined) {
              yield* sql`UPDATE tasks SET priority = ${changes.priority}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
            if (changes.url !== undefined) {
              yield* sql`UPDATE tasks SET url = ${changes.url}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
            if (changes.alarms !== undefined) {
              const encoded = changes.alarms === null ? null : JSON.stringify(changes.alarms);
              yield* sql`UPDATE tasks SET alarms = ${encoded}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
            if (changes.recurrence !== undefined) {
              const encoded =
                changes.recurrence === null ? null : JSON.stringify(changes.recurrence);
              yield* sql`UPDATE tasks SET recurrence = ${encoded}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
            if (changes.listId !== undefined && changes.listId !== listId) {
              // A move: the primary key includes list_id, so this is the whole change.
              yield* sql`UPDATE tasks SET list_id = ${changes.listId}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
          }),
        ),
      upsertLists: (lists, syncedAt) =>
        listsMutation(
          Effect.forEach(lists, (list) => upsertListRow(list, syncedAt), { discard: true }),
        ),
      upsertTasks: (tasks, syncedAt) =>
        tasksMutation(
          Effect.forEach(tasks, (task) => upsertTaskRow(task, syncedAt, false), {
            discard: true,
          }),
        ),
    };
  },
);

export class TaskRepo extends Context.Service<TaskRepo, TaskRepoShape>()('db/TaskRepo') {
  static readonly layer: Layer.Layer<TaskRepo, never, Reactivity | SqlClient> =
    Layer.effect(TaskRepo)(makeTaskRepo);
}

/** All repositories, ready to sit on a SqlClient + Reactivity. */
export const reposLayer: Layer.Layer<
  AccountRepo | CalendarRepo | EventRepo | PendingOpRepo | SyncStateRepo | TaskRepo,
  never,
  Reactivity | SqlClient
> = Layer.mergeAll(
  AccountRepo.layer,
  CalendarRepo.layer,
  EventRepo.layer,
  PendingOpRepo.layer,
  SyncStateRepo.layer,
  TaskRepo.layer,
);
