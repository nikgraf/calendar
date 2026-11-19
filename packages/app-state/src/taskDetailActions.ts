import type { TaskRecord } from '@calendar/core';
import { deleteTaskQuestion } from './deleteQuestion.ts';
import type { EditorConfirmRequest } from './editorModel.ts';
import type { useBackendMutations } from './hooks.ts';

/** Actions on the current saved row, without an editor's seeded destination or draft. */
export const taskDetailAction = async ({
  action,
  confirm,
  mutations,
  readOnly,
  task,
}: {
  readonly action: 'complete' | 'delete';
  readonly confirm: (request: EditorConfirmRequest) => Promise<boolean>;
  readonly mutations: Pick<
    ReturnType<typeof useBackendMutations>,
    'completeTask' | 'deleteTask' | 'previewDeleteTask'
  >;
  readonly readOnly: boolean;
  readonly task: TaskRecord;
}): Promise<boolean> => {
  if (readOnly) {
    return false;
  }
  const address = { accountId: task.accountId, taskId: task.id, taskListId: task.listId };
  if (action === 'complete') {
    await mutations.completeTask({
      ...address,
      status: task.status === 'completed' ? 'needsAction' : 'completed',
    });
    return true;
  }
  const { subtasks } = await mutations.previewDeleteTask(address);
  if (
    !(await confirm({
      kind: 'delete',
      subject: 'task',
      summary: deleteTaskQuestion(task.title, subtasks),
    }))
  ) {
    return false;
  }
  await mutations.deleteTask(address);
  return true;
};
