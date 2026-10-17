import { taskListGroups, useAccounts, type useTaskEditorModel } from '@calendar/app-state';
import { APPLE_REMINDERS_ACCOUNT_ID, type TaskListInfo } from '@calendar/core';
import { CardCaption, CheckRow, ColorDot, Section } from './GroupedList.tsx';

/** Which account a task list belongs to; the Reminders account is the one synthetic one. */
const groupLabel = (list: TaskListInfo, emailOf: (accountId: string) => string): string =>
  list.accountId === APPLE_REMINDERS_ACCOUNT_ID ? 'Apple Reminders' : emailOf(list.accountId);

/**
 * The task editor's list picker, shared by the Google and Reminders forms:
 * every writable list of every account as one card of check rows, the
 * account named over its lists once there is more than one. Picking a
 * list elsewhere moves the task on Save.
 */
export function TaskListPicker({
  disabled,
  taskModel,
}: {
  disabled: boolean;
  taskModel: ReturnType<typeof useTaskEditorModel>;
}) {
  const accounts = useAccounts();
  const emailOf = (accountId: string) =>
    accounts.find((account) => account.id === accountId)?.email ?? accountId;
  const groups = taskListGroups(taskModel.taskLists, (list) => groupLabel(list, emailOf));
  return (
    <Section header="List" tight>
      {groups.flatMap((group) => [
        ...(groups.length > 1
          ? [<CardCaption key={`caption:${group.label}`}>{group.label}</CardCaption>]
          : []),
        ...group.lists.map((list) => {
          const key = `${list.accountId}:${list.id}`;
          return (
            <CheckRow
              checked={key === taskModel.listKey}
              disabled={disabled}
              key={key}
              leading={list.colorHex ? <ColorDot color={list.colorHex} /> : undefined}
              onPress={() => taskModel.setListKey(key)}
              testID="task-list-option"
              title={list.title}
            />
          );
        }),
      ])}
    </Section>
  );
}
