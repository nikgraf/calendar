import { useGuardedMutations } from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import { useState } from 'react';

/**
 * The task editors' Done checkbox: it completes (or reopens) the task at
 * once, like the chips' checkbox, rather than on Save — the editor's
 * record is a snapshot, so the checked state is kept here.
 */
export function TaskDoneToggle({ task }: { task: TaskRecord }) {
  const { completeTask } = useGuardedMutations();
  const [done, setDone] = useState(task.status === 'completed');
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        checked={done}
        data-testid="task-done"
        onChange={(input) => {
          setDone(input.target.checked);
          void completeTask({
            accountId: task.accountId,
            status: input.target.checked ? 'completed' : 'needsAction',
            taskId: task.id,
            taskListId: task.listId,
          });
        }}
        type="checkbox"
      />
      Done
    </label>
  );
}
