import { placedTask, provisionalPosition } from '@calendar/core';
import type { PendingOpRepoShape, TaskRepoShape } from '@calendar/db';
import type { GcalTask, GoogleRequestError, GoogleTasksClientShape } from '@calendar/google';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

/** A task's place in its list as Google holds it. */
export interface TaskOrderEntry {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly position: string | undefined;
}

export const taskOrderEntry = (item: GcalTask): TaskOrderEntry => ({
  id: item.id,
  parentId: item.parent,
  position: item.position,
});

/**
 * A list's order on Google: one paged order-only listing. Every insert,
 * delete and move renumbers the siblings without bumping their `updated`,
 * so no `updatedMin` pull brings it (verified live).
 */
export const readTaskOrder = (
  tasksClient: GoogleTasksClientShape,
  accountId: string,
  listId: string,
): Effect.Effect<ReadonlyArray<TaskOrderEntry>, GoogleRequestError> =>
  Effect.gen(function* () {
    const entries: Array<TaskOrderEntry> = [];
    let pageToken: string | undefined;
    do {
      const page = yield* tasksClient.listTasks({
        accountId,
        params: { orderOnly: true, pageToken },
        taskListId: listId,
      });
      for (const item of page.items ?? []) {
        if (!item.deleted) {
          entries.push(taskOrderEntry(item));
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return entries;
  });

/**
 * Google's order written onto a list's rows, pending ones included (their
 * queued edits do not touch the order); then the reorders still queued
 * are replayed over it in queue order, as Google will apply them — each
 * placed by its parent and previous sibling, and each holding the place
 * before it as what a discard puts back. A queued delete holds Google's
 * place too. `landedOpId` is a reorder that just landed and is still in
 * the queue: its place is already in `entries`.
 */
export const makeApplyTaskOrder =
  (deps: { readonly pendingOpRepo: PendingOpRepoShape; readonly taskRepo: TaskRepoShape }) =>
  (
    accountId: string,
    listId: string,
    entries: ReadonlyArray<TaskOrderEntry>,
    landedOpId?: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const { pendingOpRepo, taskRepo } = deps;
      yield* taskRepo.refreshHierarchy(accountId, listId, entries);
      const google = new Map(entries.map((entry) => [entry.id, entry]));
      for (const queued of yield* pendingOpRepo.listAll()) {
        if (
          queued.id === landedOpId ||
          queued.accountId !== accountId ||
          queued.calendarId !== listId
        ) {
          continue;
        }
        const entry = google.get(queued.eventId);
        if (queued.kind === 'deleteTask' && queued.beforeTask && entry) {
          yield* pendingOpRepo.setBeforeTask(
            queued.id,
            placedTask(queued.beforeTask, {
              ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
              ...(entry.position === undefined ? {} : { position: entry.position }),
            }),
          );
        }
        const row =
          queued.kind === 'reorderTask'
            ? yield* taskRepo.get(accountId, listId, queued.eventId)
            : undefined;
        if (row === undefined) {
          continue;
        }
        yield* pendingOpRepo.setBeforeTask(queued.id, placedTask(queued.beforeTask ?? row, row));
        const siblings = (yield* taskRepo.listSiblings(
          accountId,
          listId,
          queued.taskParent,
        )).filter((sibling) => sibling.id !== row.id);
        yield* taskRepo.updateLocal({
          accountId,
          changes: {
            parentId: queued.taskParent ?? null,
            position: provisionalPosition(siblings, queued.taskPrevious),
          },
          listId,
          taskId: row.id,
        });
      }
    });
