import { type PendingOp, placedTask, TaskRecord } from '@calendar/core';
import type { PendingOpRepoShape, TaskRepoShape } from '@calendar/db';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

/**
 * Held tasks. While a change of a Google task waits in the queue, the
 * task's row shows the user's version and Google's lives beside it, once
 * per task (`TaskRepo.holdTasks`, the `task_copies` table). Pulls and
 * answers write Google's copy; the row is rebuilt here from that copy and
 * what is still queued, and is Google's again once nothing is.
 *
 * The copy carries the content (title, notes, day, status) and Google's
 * place for the task (list, parent, position). A rebuild writes the
 * content; where the row sits while a move or a reorder waits stays with
 * the code that queues and undoes those.
 */
export interface HeldTaskDeps {
  readonly pendingOpRepo: PendingOpRepoShape;
  readonly taskRepo: TaskRepoShape;
}

/** What a queued edit or toggle changes, laid over a task. */
export const withTaskChange = (task: TaskRecord, op: PendingOp): TaskRecord => {
  if (op.kind === 'completeTask' && op.taskStatus !== undefined) {
    const { completedAt, ...rest } = task;
    // The toggle's own time, as the row took it when it was made.
    const completed =
      task.status === 'completed' && completedAt !== undefined ? completedAt : op.createdAt;
    return new TaskRecord({
      ...rest,
      ...(op.taskStatus === 'completed' ? { completedAt: completed } : {}),
      status: op.taskStatus,
    });
  }
  if (op.kind === 'updateTask') {
    const { dueDate, ...rest } = task;
    const day = op.taskDue === undefined ? dueDate : (op.taskDue ?? undefined);
    return new TaskRecord({
      ...rest,
      ...(day === undefined ? {} : { dueDate: day }),
      ...(op.taskNotes === undefined ? {} : { notes: op.taskNotes }),
      ...(op.taskTitle === undefined ? {} : { title: op.taskTitle }),
    });
  }
  return task;
};

export interface HeldTasks {
  /**
   * Google's copy of a task, if a queued change holds one, in whichever
   * list Google has it.
   */
  readonly copyOf: (
    accountId: string,
    taskId: string,
  ) => Effect.Effect<TaskRecord | undefined, SqlError>;
  /**
   * A pull reported these tasks deleted in `listId`: Google has them no
   * more, so its copies go — the one kept in that list, and the one of a
   * task whose queued move shows it there (the move landed, its answer
   * lost, and Google lists the task where it took it). Nothing is left
   * for a discard to put back.
   */
  readonly forgetDeleted: (
    accountId: string,
    listId: string,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  /**
   * What still holds a task, in queue order: its own queued ops in any
   * list, and the queued moves of the task Google has it under, which take
   * it along.
   */
  readonly holders: (
    accountId: string,
    taskId: string,
    except?: string,
  ) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  /**
   * A write of the task landed and `synced` is what Google has now: its
   * copy, in the list the answer names. The row follows (`refresh`).
   * `landed` is the op that landed, still in the queue.
   */
  readonly land: (landed: PendingOp, synced: TaskRecord) => Effect.Effect<void, SqlError>;
  /**
   * Where a held task is shown while its queued moves and reorders wait:
   * the list they leave its row in and the task it is under there.
   * Undefined for a task with no copy.
   */
  readonly placeOf: (
    accountId: string,
    taskId: string,
    except?: string,
  ) => Effect.Effect<
    { readonly listId: string; readonly parentId: string | undefined } | undefined,
    SqlError
  >;
  /**
   * Rebuilds a held task's row: Google's copy with the queued edits and
   * toggles over it, pending, where the row is. With nothing queued any
   * more the row is Google's copy again and the copy goes. A task with no
   * copy is one Google has not got yet, or has no more: with nothing
   * queued for it, its row is handed back to sync. `except` is an op about
   * to leave the queue.
   */
  readonly refresh: (
    accountId: string,
    taskId: string,
    except?: string,
  ) => Effect.Effect<void, SqlError>;
}

/**
 * Where the queued moves and reorders leave a held task's row. A move
 * of its own takes it out of its parent, whose later moves then leave
 * it where it is; a move of its parent takes it along.
 */
const placeAfter = (copy: TaskRecord, ops: ReadonlyArray<PendingOp>) => {
  let listId = copy.listId;
  let parentId = copy.parentId;
  for (const op of ops) {
    if (op.kind === 'reorderTask' && op.eventId === copy.id) {
      parentId = op.taskParent;
    }
    if (op.kind !== 'moveTask' || op.targetTaskListId === undefined) {
      continue;
    }
    if (op.eventId === copy.id) {
      parentId = undefined;
      listId = op.targetTaskListId;
    } else if (op.eventId === parentId) {
      listId = op.targetTaskListId;
    }
  }
  return { listId, parentId };
};

export const makeHeldTasks = (deps: HeldTaskDeps): HeldTasks => {
  const { pendingOpRepo, taskRepo } = deps;

  const copyOf: HeldTasks['copyOf'] = (accountId, taskId) => taskRepo.findCopy(accountId, taskId);

  const holdersOf = (copy: TaskRecord | undefined, accountId: string, taskId: string) =>
    Effect.gen(function* () {
      const parentId = copy?.parentId;
      if (parentId === undefined) {
        return yield* pendingOpRepo.listForTask(accountId, taskId);
      }
      // Both at once, so the two keep their order in the queue.
      return (yield* pendingOpRepo.listAll()).filter(
        (op) =>
          op.accountId === accountId &&
          op.taskListId !== undefined &&
          (op.eventId === taskId || (op.eventId === parentId && op.kind === 'moveTask')),
      );
    });

  const placeOf: HeldTasks['placeOf'] = (accountId, taskId, except) =>
    Effect.gen(function* () {
      const copy = yield* copyOf(accountId, taskId);
      if (!copy) {
        return undefined;
      }
      const ops = (yield* holdersOf(copy, accountId, taskId)).filter((op) => op.id !== except);
      return placeAfter(copy, ops);
    });

  const holders: HeldTasks['holders'] = (accountId, taskId, except) =>
    Effect.gen(function* () {
      const copy = yield* copyOf(accountId, taskId);
      return (yield* holdersOf(copy, accountId, taskId)).filter((op) => op.id !== except);
    });

  const refresh: HeldTasks['refresh'] = (accountId, taskId, except) =>
    Effect.gen(function* () {
      const copy = yield* copyOf(accountId, taskId);
      const ops = (yield* holdersOf(copy, accountId, taskId)).filter((op) => op.id !== except);
      if (!copy) {
        const row = ops.length === 0 ? yield* taskRepo.findById(accountId, taskId) : undefined;
        if (row) {
          yield* taskRepo.markSynced(accountId, row.listId, taskId);
        }
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      if (ops.length === 0) {
        // Nothing waits for it any more: the row is Google's again.
        yield* taskRepo.upsertTasks([copy], now);
        yield* taskRepo.removeCopies(accountId, copy.listId, [taskId]);
        return;
      }
      // Deleted here: there is no row to rebuild until the delete goes.
      if (ops.some((op) => op.kind === 'deleteTask' && op.eventId === taskId)) {
        return;
      }
      const { listId, parentId } = placeAfter(copy, ops);
      const row = yield* taskRepo.get(accountId, listId, taskId);
      const content = ops
        .filter((op) => op.eventId === taskId)
        .reduce(withTaskChange, new TaskRecord({ ...copy, listId }));
      // The row keeps the place it is shown at; one that is missing takes
      // the place the queued moves give it.
      const place = row ?? { parentId, position: copy.position };
      yield* taskRepo.upsertTasks([placedTask(content, place)], now);
      yield* taskRepo.markPending(accountId, listId, taskId);
    });

  const forgetDeleted: HeldTasks['forgetDeleted'] = (accountId, listId, ids) =>
    Effect.forEach(
      ids,
      (taskId) =>
        Effect.gen(function* () {
          const copy = yield* copyOf(accountId, taskId);
          if (!copy) {
            return;
          }
          const shownIn = (yield* placeOf(accountId, taskId))?.listId;
          if (copy.listId !== listId && shownIn !== listId) {
            return;
          }
          // A queued move shows its row in another list than the one Google
          // deleted it in: that row goes with the copy.
          if (shownIn !== undefined && shownIn !== listId) {
            yield* taskRepo.removeTask(accountId, shownIn, taskId);
          }
          yield* taskRepo.removeCopies(accountId, copy.listId, [taskId]);
        }),
      { discard: true },
    );

  const land: HeldTasks['land'] = (landed, synced) =>
    Effect.gen(function* () {
      const old = yield* copyOf(landed.accountId, synced.id);
      if (old && old.listId !== synced.listId) {
        yield* taskRepo.removeCopies(landed.accountId, old.listId, [synced.id]);
      }
      yield* taskRepo.putCopy(synced);
      yield* refresh(landed.accountId, synced.id, landed.id);
    });

  return { copyOf, forgetDeleted, holders, land, placeOf, refresh };
};
