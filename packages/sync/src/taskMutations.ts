import { generateEventId } from '@calendar/google';
import { compareTaskPosition, PendingOp, provisionalPosition, TaskRecord } from '@calendar/core';
import type { PendingOpRepoShape, TaskRepoShape } from '@calendar/db';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import {
  type EventMutationsShape,
  TaskCreatePendingError,
  TaskHierarchyError,
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
  'completeTask' | 'createTask' | 'deleteTask' | 'reorderTask' | 'updateTask'
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
  readonly taskDue?: string | null | undefined;
  readonly taskNotes?: string | undefined;
  readonly taskTitle?: string | undefined;
}): TaskPatchFields => ({
  ...(source.taskDue === undefined ? {} : { taskDue: source.taskDue }),
  ...(source.taskNotes === undefined ? {} : { taskNotes: source.taskNotes }),
  ...(source.taskTitle === undefined ? {} : { taskTitle: source.taskTitle }),
});

/** A task id Google has not assigned yet: its create is still queued. */
const isTempId = (taskId: string): boolean => taskId.startsWith('local-');

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

  /** One task's delete: its row goes now, the op follows (none for a task Google never had). */
  const deleteOne = (accountId: string, taskListId: string, taskId: string) =>
    Effect.gen(function* () {
      // Google's copy stays beside the row that goes (kept already while
      // the edits this delete replaces waited): a discard puts it back.
      yield* taskRepo.holdTasks(accountId, taskListId, [taskId]);
      yield* taskRepo.removeTask(accountId, taskListId, taskId);
      // Everything queued for this task is moot now — and if its create
      // never pushed, the task never existed upstream: no server op. A
      // create that went out may have landed with its answer lost: it
      // stays, and the delete waits behind it on the temp id. Sent again,
      // it only looks for what landed (applyOp sendCreateTask), and the
      // delete then takes Google's id.
      const queued = yield* opsForEvent(accountId, taskListId, taskId);
      let unsentCreate = false;
      for (const queuedOp of queued) {
        // An earlier move out of this list (the task left and came back,
        // that move still queued) stays, as an event delete spares a move:
        // without it the move back met a 404.
        if (queuedOp.accountId !== accountId || queuedOp.kind === 'moveTask') {
          continue;
        }
        if (queuedOp.kind === 'createTask') {
          if (queuedOp.dispatchedAt !== undefined) {
            continue;
          }
          unsentCreate = true;
        }
        yield* pendingOpRepo.remove(queuedOp.id);
      }
      if (unsentCreate) {
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      yield* enqueue(
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
    });

  /**
   * The task's row, or TaskNotFoundError. A task whose delete is queued
   * has none — nothing writes one while the delete waits (a pull keeps
   * Google's copy beside it) — so a change never lands behind its own
   * task's delete.
   */
  const shown = (accountId: string, taskListId: string, taskId: string) =>
    Effect.flatMap(taskRepo.get(accountId, taskListId, taskId), (row) =>
      row ? Effect.succeed(row) : Effect.fail(new TaskNotFoundError({ taskId })),
    );

  return {
    completeTask: ({ accountId, status, taskId, taskListId }) =>
      Effect.gen(function* () {
        const window = yield* taskRepo.listLists(accountId);
        if (!window.some((list) => list.id === taskListId)) {
          return yield* Effect.fail(new TaskNotFoundError({ taskId }));
        }
        yield* shown(accountId, taskListId, taskId);
        const now = yield* Clock.currentTimeMillis;
        // Google's copy stays beside the row, for the diff and a discard.
        yield* taskRepo.holdTasks(accountId, taskListId, [taskId]);
        yield* taskRepo.setStatus({
          accountId,
          completedAt: status === 'completed' ? now : undefined,
          listId: taskListId,
          status,
          taskId,
        });
        // Only the latest toggle needs to reach Google.
        const queued = yield* opsForEvent(accountId, taskListId, taskId);
        for (const op of queued) {
          if (op.accountId === accountId && op.kind === 'completeTask') {
            yield* pendingOpRepo.remove(op.id);
          }
        }
        yield* enqueue(
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

    createSubtask: ({ parentId, ...params }) => create(params, parentId),

    createTask: (params) => create(params),

    deleteTask: ({ accountId, taskId, taskListId }) =>
      Effect.gen(function* () {
        // Google deletes a parent's subtasks with it. They go first, each a
        // delete of its own, so the rows and the queue stay in step with
        // Google and a discard puts each one back. Subtasks a move carried
        // along under an unsent create wait for it, and go without a trace.
        for (const subtask of yield* taskRepo.listSubtasks(accountId, taskListId, taskId)) {
          yield* deleteOne(accountId, taskListId, subtask.id);
        }
        yield* deleteOne(accountId, taskListId, taskId);
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
        const all = yield* pendingOpRepo.listAll();
        // The tasks Google has under it: a queued reorder may have taken one out.
        const nested = new Set(
          (yield* taskRepo.listCopies(accountId))
            .filter((copy) => copy.listId === taskListId && copy.parentId === taskId)
            .map((copy) => copy.id),
        );
        // A reorder that nests a task under it, takes one out or places it
        // or a subtask: which tasks go along is not settled until Google
        // has it, and undoing it once the rows moved could not reach them.
        if (
          all.some(
            (op) =>
              op.kind === 'reorderTask' &&
              op.accountId === accountId &&
              op.calendarId === taskListId &&
              (ids.has(op.eventId) || op.taskParent === taskId || nested.has(op.eventId)),
          )
        ) {
          return yield* Effect.fail(
            new TaskCreatePendingError({
              message:
                'A new order for this task is still being saved — move it again in a moment.',
              taskId,
            }),
          );
        }
        // An earlier move out of this list (the task was here before, and
        // came back) stays as it is: it runs before this one.
        const queued = all.filter(
          (op) =>
            op.accountId === accountId &&
            op.calendarId === taskListId &&
            ids.has(op.eventId) &&
            op.kind !== 'moveTask',
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
        // Google has them in the source until the move lands: its copies stay there.
        yield* taskRepo.holdTasks(accountId, taskListId, [...ids]);
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
        // A create of the task itself nests under nothing there (it leaves
        // its parent); its subtasks' creates keep theirs.
        for (const op of queued) {
          yield* enqueue(
            new PendingOp({
              ...op,
              ...(op.eventId === taskId ? { taskParent: undefined } : {}),
              attempts: 0,
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

    reorderTask: ({ accountId, parentId, previousId, taskId, taskListId }) =>
      Effect.gen(function* () {
        const task = yield* taskRepo.get(accountId, taskListId, taskId);
        if (!task) {
          return yield* Effect.fail(new TaskNotFoundError({ taskId }));
        }
        // Google has no id for these yet: nothing it could place, or place under.
        if (isTempId(taskId) || (parentId !== undefined && isTempId(parentId))) {
          return yield* Effect.fail(
            new TaskCreatePendingError({
              message: 'This task is still being saved to Google — move it again in a moment.',
              taskId,
            }),
          );
        }
        // A move to another list of the task, its parent or a task it is
        // placed by is not settled yet: undoing it could not reach this row.
        const involved = new Set([taskId, task.parentId, parentId, previousId]);
        if (
          (yield* pendingOpRepo.listAll()).some(
            (op) =>
              op.kind === 'moveTask' && op.accountId === accountId && involved.has(op.eventId),
          )
        ) {
          return yield* Effect.fail(
            new TaskCreatePendingError({
              message: 'A move to another list is still being saved — place it again in a moment.',
              taskId,
            }),
          );
        }
        if (parentId !== undefined) {
          const parent = yield* taskRepo.get(accountId, taskListId, parentId);
          if (!parent) {
            return yield* Effect.fail(new TaskNotFoundError({ taskId: parentId }));
          }
          // Google takes any depth; Google Tasks draws one level.
          if (parentId === taskId || parent.parentId !== undefined) {
            return yield* Effect.fail(
              new TaskHierarchyError({
                message:
                  parentId === taskId
                    ? 'A task cannot be its own subtask.'
                    : 'A subtask cannot have subtasks of its own.',
                taskId,
              }),
            );
          }
          if ((yield* taskRepo.listSubtasks(accountId, taskListId, taskId)).length > 0) {
            return yield* Effect.fail(
              new TaskHierarchyError({
                message: 'A task with subtasks cannot become a subtask.',
                taskId,
              }),
            );
          }
        }
        const siblings = (yield* taskRepo.listSiblings(accountId, taskListId, parentId)).filter(
          (sibling) => sibling.id !== taskId,
        );
        if (previousId !== undefined && !siblings.some((sibling) => sibling.id === previousId)) {
          return yield* Effect.fail(new TaskNotFoundError({ taskId: previousId }));
        }
        // A sibling whose create is still queued is drawn last, and Google
        // cannot place after it: the task goes after the last one Google has.
        const previous =
          previousId === undefined || !isTempId(previousId)
            ? previousId
            : siblings
                .filter((sibling) => !isTempId(sibling.id))
                .sort(compareTaskPosition)
                .at(-1)?.id;
        // Already there: nothing to send.
        const current = (yield* taskRepo.listSiblings(accountId, taskListId, task.parentId))
          .filter((sibling) => !isTempId(sibling.id))
          .sort(compareTaskPosition);
        const index = current.findIndex((sibling) => sibling.id === taskId);
        if (task.parentId === parentId && index >= 0 && current[index - 1]?.id === previous) {
          return;
        }
        // Stamped after the task's queued reorders, even within one
        // millisecond: an abandoned one finds those behind it by time.
        const now = yield* Clock.currentTimeMillis;
        const createdAt = Math.max(
          now,
          ...(yield* opsForEvent(accountId, taskListId, taskId))
            .filter((op) => op.kind === 'reorderTask')
            .map((op) => op.createdAt + 1),
        );
        // Shown where it was dropped until Google's order comes back;
        // Google's copy keeps the place it has there.
        yield* taskRepo.holdTasks(accountId, taskListId, [taskId]);
        yield* taskRepo.updateLocal({
          accountId,
          changes: {
            parentId: parentId ?? null,
            position: provisionalPosition(siblings, previous),
          },
          listId: taskListId,
          taskId,
        });
        yield* enqueue(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId: taskListId,
            createdAt,
            eventId: taskId,
            id: generateEventId(),
            kind: 'reorderTask',
            nextAttemptAt: 0,
            taskListId,
            ...(parentId === undefined ? {} : { taskParent: parentId }),
            ...(previous === undefined ? {} : { taskPrevious: previous }),
          }),
        );
      }),

    updateTask: ({ accountId, changes, taskId, taskListId }) =>
      Effect.gen(function* () {
        yield* shown(accountId, taskListId, taskId);
        // Google's copy stays beside the row, for the diff and a discard.
        yield* taskRepo.holdTasks(accountId, taskListId, [taskId]);
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
              // A day taken away leaves the create undated: it sends no due.
              ...(changes.dueDate === undefined ? {} : { taskDue: changes.dueDate ?? undefined }),
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
