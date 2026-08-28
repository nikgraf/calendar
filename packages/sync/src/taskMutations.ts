import { generateEventId } from '@calendar/google';
import { PendingOp, TaskRecord } from '@calendar/core';
import type { PendingOpRepoShape, TaskRepoShape } from '@calendar/db';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import {
  type EventMutationsShape,
  TaskListNotFoundError,
  TaskNotFoundError,
} from './mutationTypes.ts';

/**
 * The Google Tasks half of EventMutations: optimistic local writes + queued
 * push ops. Split out of mutations.ts; shares the queue helpers with the
 * event methods via deps. Task ids are server-assigned (creates go through
 * the temp-id/adopt protocol in applyOp.ts).
 */
export interface TaskMutationDeps {
  /** Enqueue a pending op and kick the drain (detached). */
  readonly enqueueAndKick: (op: PendingOp) => Effect.Effect<void, SqlError>;
  /** Queued ops addressed to (opaque containerId, itemId). */
  readonly opsForEvent: (
    calendarId: string,
    eventId: string,
  ) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  readonly pendingOpRepo: PendingOpRepoShape;
  readonly taskRepo: TaskRepoShape;
}

type TaskMutations = Pick<
  EventMutationsShape,
  'completeTask' | 'createTask' | 'deleteTask' | 'updateTask'
>;

export const makeTaskMutations = (deps: TaskMutationDeps): TaskMutations => {
  const { enqueueAndKick, opsForEvent, pendingOpRepo, taskRepo } = deps;
  return {
    completeTask: ({ accountId, status, taskId, taskListId }) =>
      Effect.gen(function* () {
        const window = yield* taskRepo.listLists(accountId);
        if (!window.some((list) => list.id === taskListId)) {
          return yield* Effect.fail(new TaskNotFoundError({ taskId }));
        }
        const now = yield* Clock.currentTimeMillis;
        yield* taskRepo.setStatus({
          accountId,
          completedAt: status === 'completed' ? now : undefined,
          listId: taskListId,
          status,
          taskId,
        });
        // Only the latest toggle needs to reach Google.
        const queued = yield* opsForEvent(taskListId, taskId);
        for (const op of queued) {
          if (op.accountId === accountId && op.kind === 'completeTask') {
            yield* pendingOpRepo.remove(op.id);
          }
        }
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            // Op identity reuses the event columns as opaque ids, like
            // calendarColor's sentinel does.
            calendarId: taskListId,
            createdAt: now,
            eventId: taskId,
            id: generateEventId(),
            kind: 'completeTask',
            nextAttemptAt: 0,
            taskListId,
            taskStatus: status,
          }),
        );
      }),

    createTask: ({ accountId, dueDate, notes, taskListId, title }) =>
      Effect.gen(function* () {
        const lists = yield* taskRepo.listLists(accountId);
        if (!lists.some((list) => list.id === taskListId)) {
          return yield* Effect.fail(new TaskListNotFoundError({ taskListId }));
        }
        const now = yield* Clock.currentTimeMillis;
        // The Tasks API assigns ids server-side (no client ids like
        // events): a temp id keeps the optimistic row addressable until
        // the push swaps it.
        const tempId = `local-${generateEventId()}`;
        const record = new TaskRecord({
          accountId,
          dueDate,
          id: tempId,
          listId: taskListId,
          ...(notes === undefined ? {} : { notes }),
          status: 'needsAction',
          title,
          updatedAt: now,
        });
        yield* taskRepo.insertLocal(record);
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId: taskListId,
            createdAt: now,
            eventId: tempId,
            id: generateEventId(),
            kind: 'createTask',
            nextAttemptAt: 0,
            ...(dueDate === undefined ? {} : { taskDue: dueDate }),
            taskListId,
            ...(notes === undefined ? {} : { taskNotes: notes }),
            taskTitle: title,
          }),
        );
        return record;
      }),

    deleteTask: ({ accountId, taskId, taskListId }) =>
      Effect.gen(function* () {
        yield* taskRepo.removeTask(accountId, taskListId, taskId);
        // Everything queued for this task is moot now — and if its create
        // never pushed, the task never existed upstream: no server op.
        const queued = yield* opsForEvent(taskListId, taskId);
        let unsentCreate = false;
        for (const queuedOp of queued) {
          if (queuedOp.accountId !== accountId) {
            continue;
          }
          if (queuedOp.kind === 'createTask') {
            unsentCreate = true;
          }
          yield* pendingOpRepo.remove(queuedOp.id);
        }
        if (unsentCreate) {
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId: taskListId,
            createdAt: now,
            eventId: taskId,
            id: generateEventId(),
            kind: 'deleteTask',
            nextAttemptAt: 0,
            taskListId,
          }),
        );
      }),

    updateTask: ({ accountId, changes, taskId, taskListId }) =>
      Effect.gen(function* () {
        yield* taskRepo.updateLocal({ accountId, changes, listId: taskListId, taskId });
        const now = yield* Clock.currentTimeMillis;
        const queued = yield* opsForEvent(taskListId, taskId);
        const pendingCreate = queued.find(
          (queuedOp) => queuedOp.accountId === accountId && queuedOp.kind === 'createTask',
        );
        if (pendingCreate) {
          // The create hasn't pushed: fold the edit into it instead of
          // patching a task Google has never seen.
          yield* pendingOpRepo.remove(pendingCreate.id);
          yield* enqueueAndKick(
            new PendingOp({
              ...pendingCreate,
              id: generateEventId(),
              ...(changes.dueDate === undefined ? {} : { taskDue: changes.dueDate }),
              ...(changes.notes === undefined ? {} : { taskNotes: changes.notes }),
              ...(changes.title === undefined ? {} : { taskTitle: changes.title }),
            }),
          );
          return;
        }
        // Latest wins: a newer edit supersedes queued ones.
        for (const queuedOp of queued) {
          if (queuedOp.accountId === accountId && queuedOp.kind === 'updateTask') {
            yield* pendingOpRepo.remove(queuedOp.id);
          }
        }
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId: taskListId,
            createdAt: now,
            eventId: taskId,
            id: generateEventId(),
            kind: 'updateTask',
            nextAttemptAt: 0,
            ...(changes.dueDate === undefined ? {} : { taskDue: changes.dueDate }),
            taskListId,
            ...(changes.notes === undefined ? {} : { taskNotes: changes.notes }),
            ...(changes.title === undefined ? {} : { taskTitle: changes.title }),
          }),
        );
      }),
  };
};
