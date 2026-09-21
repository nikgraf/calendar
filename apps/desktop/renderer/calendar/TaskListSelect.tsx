import { taskListGroups, useAccounts, type useTaskEditorModel } from '@calendar/app-state';
import { APPLE_REMINDERS_ACCOUNT_ID, type TaskListInfo } from '@calendar/core';
import { FIELD_CLASS, LABEL_CLASS } from './taskEditorOptions.ts';

/** Which account a task list belongs to; the Reminders account is the one synthetic one. */
const groupLabel = (list: TaskListInfo, accountLabel: (accountId: string) => string): string =>
  list.accountId === APPLE_REMINDERS_ACCOUNT_ID ? 'Apple Reminders' : accountLabel(list.accountId);

/**
 * The task editor's list picker, shared by the Google and Reminders forms:
 * every writable list of every account, grouped per account. Picking a
 * list elsewhere moves the task on Save.
 */
export function TaskListSelect({
  disabled,
  taskModel,
}: {
  disabled: boolean;
  taskModel: ReturnType<typeof useTaskEditorModel>;
}) {
  const accounts = useAccounts();
  const accountLabel = (accountId: string) =>
    accounts.find((account) => account.id === accountId)?.email ?? accountId;
  return (
    <label className={LABEL_CLASS}>
      List
      <select
        aria-label="Task list"
        className={`${FIELD_CLASS} mt-1`}
        disabled={disabled}
        onChange={(input) => taskModel.setListKey(input.target.value)}
        value={taskModel.listKey}
      >
        {taskListGroups(taskModel.taskLists, (list) => groupLabel(list, accountLabel)).map(
          (group) => (
            <optgroup key={group.label} label={group.label}>
              {group.lists.map((list) => (
                <option key={`${list.accountId}:${list.id}`} value={`${list.accountId}:${list.id}`}>
                  {list.title}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </select>
    </label>
  );
}
