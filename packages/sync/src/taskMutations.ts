import { generateEventId } from '@calendar/google';
import { PendingOp, TaskRecord } from '@calendar/core';
import type { PendingOpRepoShape, TaskRepoShape } from '@calendar/db';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import {
  type EventMutationsShape,
  TaskCreatePendingError,
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
  /** Enqueue a pending op; the caller's transaction wrapper kicks the drain after commit. */
  readonly enqueue: (op: PendingOp) => Effect.Effect<void, SqlError>;
  /** Queued ops addressed to (opaque containerId, itemId). */
  readonly opsForEvent: (
    accountId: string,
    calendarId: string,
    eventId: string,
  ) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  readonly pendingOpRepo: PendingOpRepoShape;
  readonly taskRepo: TaskRepoShape;
}

type CreateTaskParams = Parameters<EventMutationsShape['createTask']>[0];

type TaskMutations = Pick<
  EventMutationsShape,
  'completeTask' | 'createTask' | 'deleteTask' | 'updateTask'
> & {
  /**
   * A subtask a move carries along: created nested under `parentId` — a
   * temp id until that task's own create lands, which the drain waits for.
   */
  readonly createSubtask: (
    params: CreateTaskParams & { readonly parentId: string },
  ) => Effect.Effect<TaskRecord, SqlError | TaskListNotFoundError>;
  /**
   * Google → Google inside one account: `tasks.move`, which keeps the id
   * and takes the subtasks along, nested as they were; the task itself
   * leaves its parent. The rows move now, the op follows, and what was
   * queued for them is re-queued in the destination behind it.
   */
  readonly moveWithinAccount: (params: {
    readonly accountId: string;
    readonly targetTaskListId: string;
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<
    TaskRecord,
    SqlError | TaskCreatePendingError | TaskListNotFoundError | TaskNotFoundError
  >;
};

/** What an `updateTask` op patches; an absent field is left alone. */
type TaskPatchFields = Partial<Pick<PendingOp, 'taskDue' | 'taskNotes' | 'taskTitle'>>;

/** The fields an op (or an edit) sets, without the ones it leaves alone. */
const patchFields = (source: {
  readonly taskDue?: string | undefined;
  readonly taskNotes?: string | undefined;
  readonly taskTitle?: string | undefined;
}): TaskPatchFields => ({
  ...(source.taskDue === undefined ? {} : { taskDue: source.taskDue }),
  ...(source.taskNotes === undefined ? {} : { taskNotes: source.taskNotes }),
  ...(source.taskTitle === undefined ? {} : { taskTitle: source.taskTitle }),
});

/**
 * The task as Google last acknowledged it, for a delete that replaces the
 * queued ops: each op's snapshot holds the acknowledged value of the
 * fields it owns — an edit's title, notes and due day (the ones it
 * carries), a toggle's status — whatever order coalescing left the ops
 * in. A field no op touched is the row's.
 */
const acknowledgedTask = (
  queued: ReadonlyArray<PendingOp>,
  current: TaskRecord,
  accountId: string,
): TaskRecord => {
  let acked = current;
  for (const op of queued) {
    const before = op.beforeTask;
    if (op.accountId !== accountId || !before) {
      continue;
    }
    if (op.kind === 'completeTask') {
      acked = new TaskRecord({ ...acked, completedAt: before.completedAt, status: before.status });
    } else if (op.kind === 'updateTask') {
      acked = new TaskRecord({
        ...acked,
        ...(op.taskDue === undefined ? {} : { dueDate: before.dueDate }),
        ...(op.taskNotes === undefined ? {} : { notes: before.notes }),
        ...(op.taskTitle === undefined ? {} : { title: before.title }),
      });
    }
  }
  return acked;
};

export const makeTaskMutations = (deps: TaskMutationDeps): TaskMutations => {
  const { enqueue, opsForEvent, pendingOpRepo, taskRepo } = deps;

  const create = (
    { accountId, dueDate, notes, taskListId, title }: CreateTaskParams,
    parentId?: string,
  ) =>
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
        ...(dueDate === undefined ? {} : { dueDate }),
        id: tempId,
        listId: taskListId,
        ...(notes === undefined ? {} : { notes }),
        ...(parentId === undefined ? {} : { parentId }),
        provider: 'google',
        status: 'needsAction',
        title,
        updatedAt: now,
      });
      yield* taskRepo.insertLocal(record);
      yield* enqueue(
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
          ...(parentId === undefined ? {} : { taskParent: parentId }),
          taskTitle: title,
        }),
      );
      return record;
    });

  return {
    completeTask: ({ accountId, status, taskId, taskListId }) =>
      Effect.gen(function* () {
        const window = yield* taskRepo.listLists(accountId);
        if (!window.some((list) => list.id === taskListId)) {
          return yield* Effect.fail(new TaskNotFoundError({ taskId }));
        }
        const now = yield* Clock.currentTimeMillis;
        // The row before the toggle, for the diff and a discard; a replaced
        // toggle's before stays — the row already holds that toggle.
        const current = yield* taskRepo.get(accountId, taskListId, taskId);
        yield* taskRepo.setStatus({
          accountId,
          completedAt: status === 'completed' ? now : undefined,
          listId: taskListId,
          status,
          taskId,
        });
        // Only the latest toggle needs to reach Google.
        const queued = yield* opsForEvent(accountId, taskListId, taskId);
        const prior = queued.find((op) => op.accountId === accountId && op.kind === 'completeTask');
        for (const op of queued) {
          if (op.accountId === accountId && op.kind === 'completeTask') {
            yield* pendingOpRepo.remove(op.id);
          }
        }
        yield* enqueue(
          new PendingOp({
            accountId,
            attempts: 0,
            beforeTask: prior ? prior.beforeTask : current,
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

    createSubtask: ({ parentId, ...params }) => create(params, parentId),

    createTask: (params) => create(params),

    deleteTask: ({ accountId, taskId, taskListId }) =>
      Effect.gen(function* () {
        // The row as deleted — or as it was before the queued edits this
        // delete replaces — so a discard can put it back.
        const current = yield* taskRepo.get(accountId, taskListId, taskId);
        yield* taskRepo.removeTask(accountId, taskListId, taskId);
        // Everything queued for this task is moot now — and if its create
        // never pushed, the task never existed upstream: no server op.
        const queued = yield* opsForEvent(accountId, taskListId, taskId);
        const beforeTask = current ? acknowledgedTask(queued, current, accountId) : undefined;
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
          // Subtasks a move carried along under it wait for its create,
          // which will never run now: they go with it, as on Google.
          for (const subtask of yield* taskRepo.listSubtasks(accountId, taskListId, taskId)) {
            yield* taskRepo.removeTask(accountId, taskListId, subtask.id);
            for (const op of yield* opsForEvent(accountId, taskListId, subtask.id)) {
              yield* pendingOpRepo.remove(op.id);
            }
          }
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        yield* enqueue(
          new PendingOp({
            accountId,
            attempts: 0,
            beforeTask,
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

    moveWithinAccount: ({ accountId, targetTaskListId, taskId, taskListId }) =>
      Effect.gen(function* () {
        const source = yield* taskRepo.get(accountId, taskListId, taskId);
        if (!source) {
          return yield* Effect.fail(new TaskNotFoundError({ taskId }));
        }
        const lists = yield* taskRepo.listLists(accountId);
        if (!lists.some((list) => list.id === targetTaskListId)) {
          return yield* Effect.fail(new TaskListNotFoundError({ taskListId: targetTaskListId }));
        }
        const subtasks = yield* taskRepo.listSubtasks(accountId, taskListId, taskId);
        const ids = new Set([taskId, ...subtasks.map((subtask) => subtask.id)]);
        const queued = (yield* pendingOpRepo.listAll()).filter(
          (op) => op.accountId === accountId && op.calendarId === taskListId && ids.has(op.eventId),
        );
        // A create that went out may land in the source list after the
        // move: where the task ends up is not known until Google answers.
        if (queued.some((op) => op.kind === 'createTask' && op.dispatchedAt !== undefined)) {
          return yield* Effect.fail(
            new TaskCreatePendingError({
              message: 'This task is still being saved to Google — move it again in a moment.',
              taskId,
            }),
          );
        }
        const now = yield* Clock.currentTimeMillis;
        // The rows move now: the task leaves its parent, its subtasks keep it.
        for (const row of [source, ...subtasks]) {
          const { parentId, ...rest } = row;
          yield* taskRepo.removeTask(accountId, taskListId, row.id);
          yield* taskRepo.insertLocal(
            new TaskRecord({
              ...rest,
              listId: targetTaskListId,
              ...(row.id === taskId || parentId === undefined ? {} : { parentId }),
            }),
          );
        }
        for (const op of queued) {
          yield* pendingOpRepo.remove(op.id);
        }
        // A create that never went out simply lands in the destination.
        const unsentCreate = queued.some((op) => op.kind === 'createTask' && op.eventId === taskId);
        if (!unsentCreate) {
          yield* enqueue(
            new PendingOp({
              accountId,
              attempts: 0,
              beforeTask: source,
              calendarId: taskListId,
              createdAt: now,
              eventId: taskId,
              id: generateEventId(),
              kind: 'moveTask',
              nextAttemptAt: 0,
              targetTaskListId,
              taskListId,
            }),
          );
        }
        // What was queued for them follows the move, in the destination.
        for (const op of queued) {
          yield* enqueue(
            new PendingOp({
              ...op,
              attempts: 0,
              ...(op.beforeTask
                ? { beforeTask: new TaskRecord({ ...op.beforeTask, listId: targetTaskListId }) }
                : {}),
              calendarId: targetTaskListId,
              createdAt: now + 1,
              id: generateEventId(),
              lastError: undefined,
              nextAttemptAt: 0,
              taskListId: targetTaskListId,
            }),
          );
        }
        const moved = yield* taskRepo.get(accountId, targetTaskListId, taskId);
        return moved ?? new TaskRecord({ ...source, listId: targetTaskListId });
      }),

    updateTask: ({ accountId, changes, taskId, taskListId }) =>
      Effect.gen(function* () {
        // The row before the edit, for the diff and a discard.
        const current = yield* taskRepo.get(accountId, taskListId, taskId);
        // Google knows title/notes/due only; the dispatcher already rejected
        // Reminders-only fields, so this narrows rather than drops.
        yield* taskRepo.updateLocal({
          accountId,
          changes: { dueDate: changes.dueDate, notes: changes.notes, title: changes.title },
          listId: taskListId,
          taskId,
        });
        const now = yield* Clock.currentTimeMillis;
        const queued = yield* opsForEvent(accountId, taskListId, taskId);
        const pendingCreate = queued.find(
          (queuedOp) => queuedOp.accountId === accountId && queuedOp.kind === 'createTask',
        );
        if (pendingCreate && pendingCreate.dispatchedAt === undefined) {
          // The create hasn't pushed: fold the edit into it instead of
          // patching a task Google has never seen. Fresh attempt counters:
          // an edit is a reason to try again now, not to inherit backoff.
          yield* pendingOpRepo.remove(pendingCreate.id);
          yield* enqueue(
            new PendingOp({
              ...pendingCreate,
              attempts: 0,
              id: generateEventId(),
              nextAttemptAt: 0,
              ...(changes.dueDate === undefined ? {} : { taskDue: changes.dueDate }),
              ...(changes.notes === undefined ? {} : { taskNotes: changes.notes }),
              ...(changes.title === undefined ? {} : { taskTitle: changes.title }),
            }),
          );
          return;
        }
        // A dispatched create may already have landed on Google with the
        // fields it was sent: its retry adopts the server task by matching
        // exactly those, so it stays untouched and the edit queues behind
        // it as a patch. The create's id swap rewrites this op's eventId,
        // and applyOp holds a temp-id follower until then.
        // Latest wins, field by field: a newer edit supersedes queued ones,
        // but each op carries only the fields its edit changed — a rename
        // followed by a new due day must still send the rename.
        let fields: TaskPatchFields = {};
        // The earliest replaced edit's before: the row holds every later one.
        const prior = queued.find(
          (queuedOp) => queuedOp.accountId === accountId && queuedOp.kind === 'updateTask',
        );
        for (const queuedOp of queued) {
          if (queuedOp.accountId === accountId && queuedOp.kind === 'updateTask') {
            fields = { ...fields, ...patchFields(queuedOp) };
            yield* pendingOpRepo.remove(queuedOp.id);
          }
        }
        fields = {
          ...fields,
          ...patchFields({
            taskDue: changes.dueDate,
            taskNotes: changes.notes,
            taskTitle: changes.title,
          }),
        };
        yield* enqueue(
          new PendingOp({
            accountId,
            attempts: 0,
            beforeTask: prior ? prior.beforeTask : current,
            calendarId: taskListId,
            createdAt: now,
            eventId: taskId,
            id: generateEventId(),
            kind: 'updateTask',
            nextAttemptAt: 0,
            taskListId,
            ...fields,
          }),
        );
      }),
  };
};
