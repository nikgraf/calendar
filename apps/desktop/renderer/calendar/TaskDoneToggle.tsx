import { useGuardedMutations, useListColorLookup } from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import { useState } from 'react';
import { TaskCheckMark } from './TaskCheck.tsx';

/**
 * The task editors' Done checkbox: it completes (or reopens) the task at
 * once, like the chips' checkbox, rather than on Save — the editor's
 * record is a snapshot, so the checked state is kept here.
 */
export function TaskDoneToggle({ task }: { task: TaskRecord }) {
  const { completeTask } = useGuardedMutations();
  const listColorOf = useListColorLookup();
  const [done, setDone] = useState(task.status === 'completed');
  return (
    <button
      aria-checked={done}
      className="flex cursor-pointer items-center gap-2 self-start text-sm outline-none"
      data-testid="task-done"
      onClick={() => {
        setDone(!done);
        void completeTask({
          accountId: task.accountId,
          status: done ? 'needsAction' : 'completed',
          taskId: task.id,
          taskListId: task.listId,
        });
      }}
      role="checkbox"
      type="button"
    >
      <TaskCheckMark checked={done} listColor={listColorOf(task)} size="row" />
      Done
    </button>
  );
}
