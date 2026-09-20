import { type DropTarget, dropTaskChanges, type TaskRecord } from '@calendar/core';
import type { useGuardedMutations } from './mutationGuard.ts';
import { publishMutationNotice } from './mutationGuard.ts';

/** Google Tasks are date-only; the drop is refused here, before the backend sees it. */
export const GOOGLE_TIMED_DROP_NOTICE = {
  action: 'give the task a time',
  detail: 'Google Tasks are date-only; move it to a Reminders list to set a time.',
};

/**
 * Commits a task chip's drop — the same rules on both platforms: the day
 * under the release and, in the grid, its minute; a target the provider
 * cannot hold is refused with a notice, never turned into a lesser move.
 */
export const commitTaskDrop = (
  task: TaskRecord,
  dueDate: string,
  target: DropTarget,
  updateTask: ReturnType<typeof useGuardedMutations>['updateTask'],
): void => {
  const result = dropTaskChanges(
    task,
    target.kind === 'allDay'
      ? { dueDate, kind: 'allDay' }
      : { dueDate, kind: 'timed', minute: target.minute },
  );
  if (result === undefined) {
    return;
  }
  if ('unsupported' in result) {
    publishMutationNotice(GOOGLE_TIMED_DROP_NOTICE);
    return;
  }
  void updateTask({
    accountId: task.accountId,
    changes: result.changes,
    taskId: task.id,
    taskListId: task.listId,
  });
};
