import { TaskListInfo, TaskRecord } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity/Reactivity';
import { SqlClient } from 'effect/sql/SqlClient';
import type { SqlError } from 'effect/sql/SqlError';
import { OPS_KEY, TASKLISTS_KEY, TASKS_KEY } from './keys.ts';
import {
  taskFromPayload,
  taskFromRow,
  taskJsonColumns,
  taskListFromRow,
  type TaskListRow,
  type TaskRow,
} from './rows.ts';
import { accountGuard, taskPayloadJson } from './repoShared.ts';

export interface TaskRepoShape {
  /** Deletes synced tasks of the list not touched since syncedAt (full pass). */
  readonly deleteStale: (
    accountId: string,
    listId: string,
    syncedAt: number,
  ) => Effect.Effect<void, SqlError>;
  /**
   * One task by account and id, on whichever list it is now, or undefined;
   * an open row first, should a move's copy and its original overlap.
   * Google ids are list-scoped: callers must not infer that a different
   * list's row is the same task without tracking the move.
   */
  readonly findById: (
    accountId: string,
    taskId: string,
  ) => Effect.Effect<TaskRecord | undefined, SqlError>;
  /**
   * Google's copy of a task a queued change holds, by account and id, in
   * whichever list Google has it (the source list while a move waits).
   */
  readonly findCopy: (
    accountId: string,
    taskId: string,
  ) => Effect.Effect<TaskRecord | undefined, SqlError>;
  /** One task by its full key, or undefined. */
  readonly get: (
    accountId: string,
    listId: string,
    taskId: string,
  ) => Effect.Effect<TaskRecord | undefined, SqlError>;
  /**
   * Tasks completed inside [startMs, endMs), visible lists only. The
   * calendar draws a late or undated completion on the day it was
   * completed, which no due-day window finds.
   */
  readonly getCompletedBetween: (
    startMs: number,
    endMs: number,
  ) => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>;
  /** Google's copy of a held task by its full key, or undefined. */
  readonly getCopy: (
    accountId: string,
    listId: string,
    taskId: string,
  ) => Effect.Effect<TaskRecord | undefined, SqlError>;
  /**
   * Every task of the given lists as a calendar mirror reads its sources:
   * dated or not, open or completed, whether or not the list is shown on
   * this device (visibility is a local toggle; two devices must read the
   * same sources).
   */
  readonly getMirrorSource: (
    accountId: string,
    listIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>;
  /** Open tasks due strictly before `before`, visible lists only — the ones today's lane shows as overdue. */
  readonly getOverdue: (before: string) => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>;
  /** Open tasks without a due day, visible lists only — drawn on today until they are done. */
  readonly getUndatedOpen: () => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>;
  /**
   * Every task of the visible lists — open or completed, dated or not:
   * what search looks through (it matches in TypeScript, since SQLite's
   * LIKE folds neither accents nor non-ASCII case).
   */
  readonly getVisible: () => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>;
  /** Tasks with a due day inside [startDate, endDate], visible lists only. */
  readonly getWindow: (
    startDate: string,
    endDate: string,
  ) => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>;
  /**
   * Keeps Google's copy of these tasks before a local change takes their
   * rows: each synced row is stored as it is, once (a task already held
   * keeps the copy it has, and a row Google has not got yet has none).
   * While a copy exists, pulls and answers write Google's version there
   * and the row is rebuilt from it and the queued changes.
   */
  readonly holdTasks: (
    accountId: string,
    listId: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  /** Optimistic local create (sync_status 'pending' until the push lands). */
  readonly insertLocal: (task: TaskRecord) => Effect.Effect<void, SqlError>;
  /** Every copy Google's side of the account's held tasks has, in any list. */
  readonly listCopies: (accountId: string) => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>;
  readonly listLists: (accountId?: string) => Effect.Effect<ReadonlyArray<TaskListInfo>, SqlError>;
  /**
   * The tasks of a list under one parent — the top-level ones without
   * `parentId` — in Google's order: the siblings a reorder places among.
   */
  readonly listSiblings: (
    accountId: string,
    listId: string,
    parentId: string | undefined,
  ) => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>;
  /** A Google task's subtasks, in Google's order. */
  readonly listSubtasks: (
    accountId: string,
    listId: string,
    parentId: string,
  ) => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>;
  /**
   * The ids of a list's pulled copies (synced rows, none a queued op
   * owns): the rows a listing of the list that no longer names them may
   * remove.
   */
  readonly listSyncedIds: (
    accountId: string,
    listId: string,
  ) => Effect.Effect<ReadonlyArray<string>, SqlError>;
  /**
   * Keeps a row out of the pulls' way: a discarded op put the row back
   * whole (`upsertTasks`, which writes it synced) while another op of the
   * task is still queued and owns it.
   */
  readonly markPending: (
    accountId: string,
    listId: string,
    taskId: string,
  ) => Effect.Effect<void, SqlError>;
  /** Hands a row back to sync after its queued edit was abandoned. */
  readonly markSynced: (
    accountId: string,
    listId: string,
    taskId: string,
  ) => Effect.Effect<void, SqlError>;
  /** Stores Google's copy of a task, replacing the one held for its key. */
  readonly putCopy: (task: TaskRecord) => Effect.Effect<void, SqlError>;
  /**
   * Google's order for a list (each task's parent and position), written
   * onto its rows whatever their sync state: a move renumbers its
   * siblings without touching their `updated`, so no pull ever brings it,
   * and a queued edit, toggle or delete does not touch the order. The
   * caller replays the queued reorders over it.
   */
  readonly refreshHierarchy: (
    accountId: string,
    listId: string,
    entries: ReadonlyArray<{
      readonly id: string;
      readonly parentId: string | undefined;
      readonly position: string | undefined;
    }>,
  ) => Effect.Effect<void, SqlError>;
  /** Session-only links for an open detail whose queued Google create acquired a server id. */
  readonly rememberCreatedId: (
    accountId: string,
    listId: string,
    tempId: string,
    serverId: string,
  ) => Effect.Effect<void>;
  /** Forgets Google's copies of these tasks: nothing holds them, or Google has them no more. */
  readonly removeCopies: (
    accountId: string,
    listId: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  readonly removeListsMissing: (
    accountId: string,
    keepIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  /** Removes a row only when it is a pulled copy (synced), never one a queued op owns. */
  readonly removeSyncedTask: (
    accountId: string,
    listId: string,
    taskId: string,
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
  }) => Effect.Effect<{ readonly needsFull: boolean; readonly skipped: boolean }, SqlError>;
  /** Points subtasks at their parent's server id once its temp id is swapped. */
  readonly replaceParent: (
    accountId: string,
    tempId: string,
    serverId: string,
  ) => Effect.Effect<void, SqlError>;
  readonly resolveCreatedId: (
    accountId: string,
    listId: string,
    taskId: string,
  ) => Effect.Effect<string>;
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
   * Google's newer version of tasks, written to the copies that exist
   * (the held ones); returns those. The rest have no copy: their rows
   * are Google's and the caller writes them.
   */
  readonly updateCopies: (
    tasks: ReadonlyArray<TaskRecord>,
  ) => Effect.Effect<ReadonlyArray<TaskRecord>, SqlError>;
  /**
   * Optimistic edit. `undefined` leaves a field alone; `null` clears the
   * Reminders-only fields; `listId` in changes moves the row (Reminders).
   */
  readonly updateLocal: (params: {
    readonly accountId: string;
    readonly changes: {
      readonly alarms?: ReadonlyArray<number> | null | undefined;
      /** null takes the day away (and with it any due time). */
      readonly dueDate?: string | null | undefined;
      readonly dueTime?: string | null | undefined;
      readonly listId?: string | undefined;
      readonly notes?: string | undefined;
      /** Google: the task it is a subtask of; null makes it a task of its own. */
      readonly parentId?: string | null | undefined;
      /** Google: its place among its siblings (a reorder's provisional one). */
      readonly position?: string | undefined;
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
  /**
   * `mode: 'pull'` (sync pages) leaves rows with a queued local edit
   * (`sync_status = 'pending'`) untouched; the default ('ack', push
   * responses and mirror writes) overwrites.
   */
  readonly upsertTasks: (
    tasks: ReadonlyArray<TaskRecord>,
    syncedAt: number,
    options?: { readonly mode?: 'ack' | 'pull' },
  ) => Effect.Effect<void, SqlError>;
}

const createdKey = (accountId: string, listId: string, taskId: string) =>
  JSON.stringify([accountId, listId, taskId]);

const makeTaskRepo: Effect.Effect<TaskRepoShape, never, Reactivity | SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    // Views do not survive a backend restart. Bound the session's create aliases,
    // and scope them to the full key: Google ids are unique only within a list.
    const createdIds = new Map<string, string>();
    const tasksMutation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([TASKS_KEY], effect);
    const listsMutation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([TASKLISTS_KEY, TASKS_KEY], effect);

    /**
     * One task row upsert. 'newer' is the mirror's write-through guard;
     * 'notPending' keeps a pull from overwriting a queued local edit.
     */
    const upsertTaskRow = (
      task: TaskRecord,
      syncedAt: number,
      guardKind: 'newer' | 'none' | 'notPending',
    ) => {
      const json = taskJsonColumns(task);
      const guard =
        guardKind === 'newer'
          ? sql`WHERE excluded.updated_at > tasks.updated_at`
          : guardKind === 'notPending'
            ? sql`WHERE tasks.sync_status != 'pending'`
            : sql``;
      return sql`
              INSERT INTO tasks (account_id, list_id, id, title, notes, status, due_date,
                                 completed_at, web_view_link, updated_at, synced_at,
                                 sync_status, due_time, priority, url, alarms, recurrence,
                                 external_id, due_utc, parent_id, position)
              SELECT ${task.accountId}, ${task.listId}, ${task.id}, ${task.title},
                     ${task.notes ?? null}, ${task.status}, ${task.dueDate ?? null},
                     ${task.completedAt ?? null}, ${task.webViewLink ?? null},
                     ${task.updatedAt}, ${syncedAt}, 'synced',
                     ${task.dueTime ?? null}, ${task.priority ?? null}, ${task.url ?? null},
                     ${json.alarms}, ${json.recurrence},
                     ${task.externalId ?? null}, ${task.dueUtc ?? null},
                     ${task.parentId ?? null}, ${task.position ?? null}
              ${accountGuard(sql, task.accountId)}
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
                recurrence = excluded.recurrence,
                external_id = excluded.external_id,
                due_utc = excluded.due_utc,
                parent_id = excluded.parent_id,
                position = excluded.position
              ${guard}`;
    };

    const upsertListRow = (list: TaskListInfo, syncedAt: number) => sql`
              INSERT INTO task_lists (account_id, id, title, is_visible, synced_at, provider,
                                      color_hex, read_only)
              SELECT ${list.accountId}, ${list.id}, ${list.title},
                     ${list.isVisible ? 1 : 0}, ${syncedAt}, ${list.provider},
                     ${list.colorHex ?? null}, ${list.readOnly ? 1 : 0}
              ${accountGuard(sql, list.accountId)}
              ON CONFLICT (account_id, id) DO UPDATE SET
                title = excluded.title,
                synced_at = excluded.synced_at,
                provider = excluded.provider,
                color_hex = excluded.color_hex,
                read_only = excluded.read_only`;

    return {
      deleteStale: (accountId, listId, syncedAt) =>
        tasksMutation(
          Effect.asVoid(
            sql`DELETE FROM tasks WHERE account_id = ${accountId}
              AND list_id = ${listId} AND synced_at < ${syncedAt}
              AND sync_status = 'synced'`,
          ),
        ),
      findById: (accountId, taskId) =>
        Effect.map(
          sql<TaskRow>`
            SELECT t.*, l.provider AS list_provider FROM tasks t
            JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
            WHERE t.account_id = ${accountId} AND t.id = ${taskId}
            ORDER BY t.status = 'needsAction' DESC`,
          (rows) => (rows[0] ? taskFromRow(rows[0]) : undefined),
        ),
      findCopy: (accountId, taskId) =>
        Effect.map(
          sql<{ readonly payload: string }>`SELECT payload FROM task_copies
            WHERE account_id = ${accountId} AND id = ${taskId}`,
          (rows) => (rows[0] ? taskFromPayload(rows[0].payload) : undefined),
        ),
      get: (accountId, listId, taskId) =>
        Effect.map(
          sql<TaskRow>`
            SELECT t.*, l.provider AS list_provider FROM tasks t
            JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
            WHERE t.account_id = ${accountId} AND t.list_id = ${listId} AND t.id = ${taskId}`,
          (rows) => (rows[0] ? taskFromRow(rows[0]) : undefined),
        ),
      getCompletedBetween: (startMs, endMs) =>
        Effect.map(
          sql<TaskRow>`
            SELECT t.*, l.provider AS list_provider FROM tasks t
            JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
            WHERE l.is_visible = 1
              AND t.status = 'completed'
              AND t.completed_at >= ${startMs} AND t.completed_at < ${endMs}
            ORDER BY t.completed_at, t.title`,
          (rows) => rows.map(taskFromRow),
        ),
      getCopy: (accountId, listId, taskId) =>
        Effect.map(
          sql<{ readonly payload: string }>`SELECT payload FROM task_copies
            WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`,
          (rows) => (rows[0] ? taskFromPayload(rows[0].payload) : undefined),
        ),
      getMirrorSource: (accountId, listIds) =>
        listIds.length === 0
          ? Effect.succeed([])
          : Effect.map(
              sql<TaskRow>`
                SELECT t.*, l.provider AS list_provider FROM tasks t
                JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
                WHERE t.account_id = ${accountId} AND t.list_id IN ${sql.in(listIds)}
                ORDER BY t.list_id, t.id`,
              (rows) => rows.map(taskFromRow),
            ),
      getOverdue: (before) =>
        Effect.map(
          sql<TaskRow>`
            SELECT t.*, l.provider AS list_provider FROM tasks t
            JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
            WHERE l.is_visible = 1
              AND t.status = 'needsAction'
              AND t.due_date IS NOT NULL
              AND t.due_date < ${before}
            ORDER BY t.due_date, t.due_time IS NULL, t.due_time, t.title`,
          (rows) => rows.map(taskFromRow),
        ),
      getUndatedOpen: () =>
        Effect.map(
          sql<TaskRow>`
            SELECT t.*, l.provider AS list_provider FROM tasks t
            JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
            WHERE l.is_visible = 1
              AND t.status = 'needsAction'
              AND t.due_date IS NULL
            ORDER BY t.title`,
          (rows) => rows.map(taskFromRow),
        ),
      getVisible: () =>
        Effect.map(
          sql<TaskRow>`
            SELECT t.*, l.provider AS list_provider FROM tasks t
            JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
            WHERE l.is_visible = 1`,
          (rows) => rows.map(taskFromRow),
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
      holdTasks: (accountId, listId, ids) =>
        Effect.forEach(
          ids,
          (id) =>
            Effect.gen(function* () {
              const rows = yield* sql<TaskRow>`
                SELECT t.*, l.provider AS list_provider FROM tasks t
                JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
                WHERE t.account_id = ${accountId} AND t.list_id = ${listId} AND t.id = ${id}
                  AND t.sync_status = 'synced'`;
              const row = rows[0];
              if (row) {
                // A synced row here is where Google has the task now: a copy
                // of it in another list (another device moved it while a
                // change of it waited) is what Google had before, and goes.
                yield* sql`DELETE FROM task_copies WHERE account_id = ${accountId}
                  AND id = ${id} AND list_id != ${listId}`;
                yield* sql`INSERT OR IGNORE INTO task_copies (account_id, list_id, id, payload)
                  VALUES (${accountId}, ${listId}, ${id},
                          ${JSON.stringify(taskPayloadJson(taskFromRow(row)))})`;
              }
            }),
          { discard: true },
        ),
      insertLocal: (task) =>
        tasksMutation(
          Effect.asVoid(
            sql`
            INSERT INTO tasks (account_id, list_id, id, title, notes, status, due_date,
                               completed_at, web_view_link, updated_at, synced_at, sync_status,
                               due_time, priority, url, alarms, recurrence, external_id, due_utc,
                               parent_id, position)
            VALUES (${task.accountId}, ${task.listId}, ${task.id}, ${task.title},
                    ${task.notes ?? null}, ${task.status}, ${task.dueDate ?? null},
                    ${task.completedAt ?? null}, ${task.webViewLink ?? null},
                    ${task.updatedAt}, ${task.updatedAt}, 'pending',
                    ${task.dueTime ?? null}, ${task.priority ?? null}, ${task.url ?? null},
                    ${taskJsonColumns(task).alarms}, ${taskJsonColumns(task).recurrence},
                    ${task.externalId ?? null}, ${task.dueUtc ?? null},
                    ${task.parentId ?? null}, ${task.position ?? null})`,
          ),
        ),
      listCopies: (accountId) =>
        Effect.map(
          sql<{ readonly payload: string }>`SELECT payload FROM task_copies
            WHERE account_id = ${accountId} ORDER BY list_id, id`,
          (rows) =>
            rows.flatMap((row) => {
              const task = taskFromPayload(row.payload);
              return task ? [task] : [];
            }),
        ),
      listLists: (accountId) =>
        Effect.map(
          accountId === undefined
            ? sql<TaskListRow>`SELECT * FROM task_lists ORDER BY account_id, title`
            : sql<TaskListRow>`SELECT * FROM task_lists WHERE account_id = ${accountId} ORDER BY title`,
          (rows) => rows.map(taskListFromRow),
        ),

      listSiblings: (accountId, listId, parentId) =>
        Effect.map(
          sql<TaskRow>`
            SELECT t.*, l.provider AS list_provider FROM tasks t
            JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
            WHERE t.account_id = ${accountId} AND t.list_id = ${listId}
              AND ${parentId === undefined ? sql`t.parent_id IS NULL` : sql`t.parent_id = ${parentId}`}
            ORDER BY t.position IS NULL, t.position, t.id`,
          (rows) => rows.map(taskFromRow),
        ),

      listSubtasks: (accountId, listId, parentId) =>
        Effect.map(
          sql<TaskRow>`
            SELECT t.*, l.provider AS list_provider FROM tasks t
            JOIN task_lists l ON l.account_id = t.account_id AND l.id = t.list_id
            WHERE t.account_id = ${accountId} AND t.list_id = ${listId}
              AND t.parent_id = ${parentId}
            ORDER BY t.position IS NULL, t.position, t.id`,
          (rows) => rows.map(taskFromRow),
        ),

      listSyncedIds: (accountId, listId) =>
        Effect.map(
          sql<{ id: string }>`
            SELECT id FROM tasks
            WHERE account_id = ${accountId} AND list_id = ${listId}
              AND sync_status = 'synced'`,
          (rows) => rows.map((row) => row.id),
        ),

      markPending: (accountId, listId, taskId) =>
        tasksMutation(
          Effect.asVoid(
            sql`UPDATE tasks SET sync_status = 'pending'
              WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`,
          ),
        ),
      markSynced: (accountId, listId, taskId) =>
        tasksMutation(
          Effect.asVoid(
            sql`UPDATE tasks SET sync_status = 'synced'
              WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`,
          ),
        ),
      putCopy: (task) =>
        reactivity.mutation(
          [OPS_KEY],
          Effect.asVoid(
            sql`INSERT OR REPLACE INTO task_copies (account_id, list_id, id, payload)
              VALUES (${task.accountId}, ${task.listId}, ${task.id},
                      ${JSON.stringify(taskPayloadJson(task))})`,
          ),
        ),
      refreshHierarchy: (accountId, listId, entries) =>
        entries.length === 0
          ? Effect.void
          : tasksMutation(
              sql.withTransaction(
                Effect.forEach(
                  entries,
                  (entry) =>
                    sql`UPDATE tasks SET parent_id = ${entry.parentId ?? null},
                      position = ${entry.position ?? null}
                      WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${entry.id}
                        AND (parent_id IS NOT ${entry.parentId ?? null}
                          OR position IS NOT ${entry.position ?? null})`,
                  { discard: true },
                ),
              ),
            ),
      rememberCreatedId: (accountId, listId, tempId, serverId) =>
        Effect.sync(() => {
          const key = createdKey(accountId, listId, tempId);
          createdIds.delete(key);
          createdIds.set(key, serverId);
          if (createdIds.size > 512) {
            createdIds.delete(createdIds.keys().next().value!);
          }
        }),

      removeCopies: (accountId, listId, ids) =>
        ids.length === 0
          ? Effect.void
          : Effect.asVoid(
              sql`DELETE FROM task_copies WHERE account_id = ${accountId}
                AND list_id = ${listId} AND id IN ${sql.in(ids)}`,
            ),
      removeListsMissing: (accountId, keepIds) =>
        listsMutation(
          Effect.gen(function* () {
            if (keepIds.length === 0) {
              yield* sql`DELETE FROM tasks WHERE account_id = ${accountId}`;
              yield* sql`DELETE FROM task_copies WHERE account_id = ${accountId}`;
              yield* sql`DELETE FROM task_lists WHERE account_id = ${accountId}`;
              return;
            }
            yield* sql`DELETE FROM tasks WHERE account_id = ${accountId}
              AND list_id NOT IN ${sql.in(keepIds)}`;
            yield* sql`DELETE FROM task_copies WHERE account_id = ${accountId}
              AND list_id NOT IN ${sql.in(keepIds)}`;
            yield* sql`DELETE FROM task_lists WHERE account_id = ${accountId}
              AND id NOT IN ${sql.in(keepIds)}`;
          }),
        ),
      removeSyncedTask: (accountId, listId, taskId) =>
        tasksMutation(
          Effect.asVoid(
            sql`DELETE FROM tasks WHERE account_id = ${accountId}
              AND list_id = ${listId} AND id = ${taskId} AND sync_status = 'synced'`,
          ),
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
              yield* Effect.forEach(changed, (task) => upsertTaskRow(task, syncedAt, 'newer'), {
                discard: true,
              });
              yield* sql`DELETE FROM tasks WHERE account_id = ${accountId}
                AND synced_at < ${syncedAt}
                AND NOT EXISTS (SELECT 1 FROM mirror_snapshot s
                                WHERE s.list_id = tasks.list_id AND s.id = tasks.id)`;
              const owner = yield* sql<{ n: number }>`
                SELECT COUNT(*) AS n FROM accounts WHERE id = ${accountId}`;
              if ((owner[0]?.n ?? 0) === 0) {
                // Removed while the snapshot was in flight: the guarded
                // upserts above wrote nothing, and there is nothing to keep.
                return { needsFull: false, skipped: true };
              }
              const missing = yield* sql<{ n: number }>`
                SELECT COUNT(*) AS n FROM mirror_snapshot s
                WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.account_id = ${accountId}
                                  AND t.list_id = s.list_id AND t.id = s.id)`;
              return { needsFull: (missing[0]?.n ?? 0) > 0, skipped: false };
            }),
          ),
        ),
      replaceParent: (accountId, tempId, serverId) =>
        tasksMutation(
          Effect.asVoid(
            sql`UPDATE tasks SET parent_id = ${serverId}
              WHERE account_id = ${accountId} AND parent_id = ${tempId}`,
          ),
        ),
      resolveCreatedId: (accountId, listId, taskId) =>
        Effect.sync(() => createdIds.get(createdKey(accountId, listId, taskId)) ?? taskId),
      setListVisible: (accountId, listId, isVisible) =>
        listsMutation(
          Effect.asVoid(
            sql`UPDATE task_lists SET is_visible = ${isVisible ? 1 : 0}
              WHERE account_id = ${accountId} AND id = ${listId}`,
          ),
        ),
      // Local writes mark the row pending: pulls skip it until the push
      // response (or an abandoned op) hands it back.
      setStatus: ({ accountId, completedAt, listId, status, taskId }) =>
        tasksMutation(
          Effect.asVoid(
            sql`UPDATE tasks SET status = ${status}, completed_at = ${completedAt ?? null},
              sync_status = 'pending'
              WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`,
          ),
        ),
      updateCopies: (tasks) =>
        Effect.gen(function* () {
          const accountId = tasks[0]?.accountId;
          if (accountId === undefined) {
            return [];
          }
          // Few tasks are held at a time: matched here, not row by row in SQL.
          const keys = new Set(
            (yield* sql<{ readonly id: string; readonly list_id: string }>`
              SELECT list_id, id FROM task_copies WHERE account_id = ${accountId}`).map((row) =>
              JSON.stringify([row.list_id, row.id]),
            ),
          );
          const held = tasks.filter(
            (task) =>
              task.accountId === accountId && keys.has(JSON.stringify([task.listId, task.id])),
          );
          if (held.length === 0) {
            return held;
          }
          yield* reactivity.mutation(
            [OPS_KEY],
            Effect.forEach(
              held,
              (task) =>
                sql`UPDATE task_copies SET payload = ${JSON.stringify(taskPayloadJson(task))}
                  WHERE account_id = ${task.accountId} AND list_id = ${task.listId}
                    AND id = ${task.id}`,
              { discard: true },
            ),
          );
          return held;
        }),
      updateLocal: ({ accountId, changes, listId, taskId }) =>
        tasksMutation(
          Effect.gen(function* () {
            yield* sql`UPDATE tasks SET sync_status = 'pending'
              WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            if (changes.title !== undefined) {
              yield* sql`UPDATE tasks SET title = ${changes.title}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
            if (changes.notes !== undefined) {
              yield* sql`UPDATE tasks SET notes = ${changes.notes}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
            if (changes.dueDate === null) {
              yield* sql`UPDATE tasks SET due_date = NULL, due_time = NULL, due_utc = NULL
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            } else if (changes.dueDate !== undefined) {
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
            if (changes.parentId !== undefined) {
              yield* sql`UPDATE tasks SET parent_id = ${changes.parentId}
                WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`;
            }
            if (changes.position !== undefined) {
              yield* sql`UPDATE tasks SET position = ${changes.position}
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
      upsertTasks: (tasks, syncedAt, options) =>
        tasksMutation(
          Effect.forEach(
            tasks,
            (task) =>
              upsertTaskRow(task, syncedAt, options?.mode === 'pull' ? 'notPending' : 'none'),
            {
              discard: true,
            },
          ),
        ),
    };
  },
);

export class TaskRepo extends Context.Service<TaskRepo, TaskRepoShape>()('db/TaskRepo') {
  static readonly layer: Layer.Layer<TaskRepo, never, Reactivity | SqlClient> =
    Layer.effect(TaskRepo)(makeTaskRepo);
}
