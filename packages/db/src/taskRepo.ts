import { TaskListInfo, TaskRecord } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { TASKLISTS_KEY, TASKS_KEY } from './keys.ts';
import {
  taskFromRow,
  taskJsonColumns,
  taskListFromRow,
  type TaskListRow,
  type TaskRow,
} from './rows.ts';
import { accountGuard } from './repoShared.ts';

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
  /** Hands a row back to sync after its queued edit was abandoned. */
  readonly markSynced: (
    accountId: string,
    listId: string,
    taskId: string,
  ) => Effect.Effect<void, SqlError>;
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
  }) => Effect.Effect<{ readonly needsFull: boolean; readonly skipped: boolean }, SqlError>;
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

const makeTaskRepo: Effect.Effect<TaskRepoShape, never, Reactivity | SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
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
                                 sync_status, due_time, priority, url, alarms, recurrence)
              SELECT ${task.accountId}, ${task.listId}, ${task.id}, ${task.title},
                     ${task.notes ?? null}, ${task.status}, ${task.dueDate ?? null},
                     ${task.completedAt ?? null}, ${task.webViewLink ?? null},
                     ${task.updatedAt}, ${syncedAt}, 'synced',
                     ${task.dueTime ?? null}, ${task.priority ?? null}, ${task.url ?? null},
                     ${json.alarms}, ${json.recurrence}
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
                recurrence = excluded.recurrence
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

      markSynced: (accountId, listId, taskId) =>
        tasksMutation(
          Effect.asVoid(
            sql`UPDATE tasks SET sync_status = 'synced'
              WHERE account_id = ${accountId} AND list_id = ${listId} AND id = ${taskId}`,
          ),
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
