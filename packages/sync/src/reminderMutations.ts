import type { AccountRepoShape, TaskRepoShape } from '@calendar/db';
import { mapReminder, type RemindersClientShape, toReminderWrite } from '@calendar/reminders';
import { Clock, Effect } from 'effect';
import type { EventMutationsShape } from './mutationTypes.ts';

/**
 * The Apple Reminders half of the task mutations. EventKit is local and
 * synchronous, so there is no optimistic row and no pending op: each call
 * writes EventKit first and mirrors the returned reminder into SQLite —
 * the same row the sync pass would produce, just earlier.
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
        yield* taskRepo.upsertTasks([mapReminder(reminder, accountId)], now);
      }).pipe(flagAccessLoss(accountId)),

    createTask: ({ accountId, taskListId, ...fields }) =>
      Effect.gen(function* () {
        const reminder = yield* remindersClient.create({
          listId: taskListId,
          reminder: toReminderWrite(fields),
        });
        const record = mapReminder(reminder, accountId);
        const now = yield* Clock.currentTimeMillis;
        yield* taskRepo.upsertTasks([record], now);
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
        yield* taskRepo.removeTask(accountId, taskListId, taskId);
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
        if (moveToListId !== undefined && moveToListId !== taskListId) {
          // The primary key includes the list: drop the old row, the upsert
          // below writes the new one.
          yield* taskRepo.removeTask(accountId, taskListId, taskId);
        }
        yield* taskRepo.upsertTasks([mapReminder(reminder, accountId)], now);
      }).pipe(flagAccessLoss(accountId)),
  };
};
