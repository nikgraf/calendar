import type { AccountRepoShape, TaskRepoShape } from '@calendar/db';
import { mapReminder, type RemindersClientShape, toReminderWrite } from '@calendar/reminders';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import type { EventMutationsShape } from './mutationTypes.ts';

/**
 * The Apple Reminders half of the task mutations. EventKit is local and
 * synchronous, so there is no optimistic row and no pending op: each call
 * writes EventKit first and mirrors the returned reminder into SQLite —
 * the same row the sync pass would produce, just earlier.
 *
 * Once EventKit has committed, the write has happened whatever the mirror
 * does: a SQLite failure after that is logged, not raised. Raising it
 * would show the editor an error for a reminder that exists, and a
 * retried Save would create it a second time. Our own EventKit write
 * fires EKEventStoreChanged, so the debounced delta pass restores the
 * missed row within about a second anyway.
 */
export interface ReminderMutationDeps {
  readonly accountRepo: AccountRepoShape;
  readonly remindersClient: RemindersClientShape;
  readonly taskRepo: TaskRepoShape;
}

type TaskMutations = Pick<
  EventMutationsShape,
  'completeTask' | 'createTask' | 'deleteTask' | 'updateTask'
>;

/** A mirror write after a committed EventKit change: best effort, never fatal. */
const mirror = (method: string, write: Effect.Effect<void, SqlError>): Effect.Effect<void> =>
  Effect.catchTag(write, 'SqlError', (error) =>
    Effect.logWarning('reminders mirror write failed; the next pass repairs it', {
      error: error.message,
      method,
    }),
  );

export const makeReminderMutations = (deps: ReminderMutationDeps): TaskMutations => {
  const { accountRepo, remindersClient, taskRepo } = deps;

  /** Lost access mid-flight: flag the account so the UI offers the way back. */
  const flagAccessLoss =
    (accountId: string) =>
    <A, E extends { readonly _tag: string }, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.tapError(effect, (error) =>
        error._tag === 'RemindersAccessError'
          ? Effect.ignore(accountRepo.setStatus(accountId, 'reauth_required'))
          : Effect.void,
      );

  return {
    completeTask: ({ accountId, status, taskId }) =>
      Effect.gen(function* () {
        const reminder = yield* remindersClient.setCompleted({
          completed: status === 'completed',
          id: taskId,
        });
        const now = yield* Clock.currentTimeMillis;
        yield* mirror(
          'completeTask',
          taskRepo.upsertTasks([mapReminder(reminder, accountId)], now),
        );
      }).pipe(flagAccessLoss(accountId)),

    createTask: ({ accountId, taskListId, ...fields }) =>
      Effect.gen(function* () {
        const reminder = yield* remindersClient.create({
          listId: taskListId,
          reminder: toReminderWrite(fields),
        });
        const record = mapReminder(reminder, accountId);
        const now = yield* Clock.currentTimeMillis;
        yield* mirror('createTask', taskRepo.upsertTasks([record], now));
        return record;
      }).pipe(flagAccessLoss(accountId)),

    deleteTask: ({ accountId, taskId, taskListId }) =>
      Effect.gen(function* () {
        // Already gone in Reminders.app (deleted between two passes): the
        // user's intent is met — drop the stale mirror row, like the
        // Google path does on NotFoundError.
        yield* remindersClient
          .delete({ id: taskId })
          .pipe(
            Effect.catchTag('RemindersRequestError', (error) =>
              error.message.startsWith('notFound') ? Effect.void : Effect.fail(error),
            ),
          );
        yield* mirror('deleteTask', taskRepo.removeTask(accountId, taskListId, taskId));
      }).pipe(flagAccessLoss(accountId)),

    updateTask: ({ accountId, changes, taskId, taskListId }) =>
      Effect.gen(function* () {
        const { moveToListId, ...fields } = changes;
        const reminder = yield* remindersClient.update({
          changes: {
            ...toReminderWrite(fields),
            ...(moveToListId === undefined ? {} : { listId: moveToListId }),
          },
          id: taskId,
        });
        const now = yield* Clock.currentTimeMillis;
        yield* mirror(
          'updateTask',
          Effect.gen(function* () {
            if (moveToListId !== undefined && moveToListId !== taskListId) {
              // The primary key includes the list: drop the old row, the
              // upsert below writes the new one.
              yield* taskRepo.removeTask(accountId, taskListId, taskId);
            }
            yield* taskRepo.upsertTasks([mapReminder(reminder, accountId)], now);
          }),
        );
      }).pipe(flagAccessLoss(accountId)),
  };
};
