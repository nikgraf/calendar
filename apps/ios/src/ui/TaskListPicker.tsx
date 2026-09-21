import { taskListGroups, useAccounts, type useTaskEditorModel } from '@calendar/app-state';
import { APPLE_REMINDERS_ACCOUNT_ID, type TaskListInfo } from '@calendar/core';
import { Pressable, Text, View } from 'react-native';
import { sheetStyles as styles } from './editSheetShared.ts';

/** Which account a task list belongs to; the Reminders account is the one synthetic one. */
const groupLabel = (list: TaskListInfo, emailOf: (accountId: string) => string): string =>
  list.accountId === APPLE_REMINDERS_ACCOUNT_ID ? 'Apple Reminders' : emailOf(list.accountId);

/**
 * The task editor's list picker, shared by the Google and Reminders forms:
 * every writable list of every account, grouped per account. Picking a
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
  return (
    <>
      <Text style={styles.label}>List</Text>
      {taskListGroups(taskModel.taskLists, (list) => groupLabel(list, emailOf)).map((group) => (
        <View key={group.label}>
          <Text style={styles.calendarGroup}>{group.label}</Text>
          {group.lists.map((list) => {
            const key = `${list.accountId}:${list.id}`;
            const selected = key === taskModel.listKey;
            return (
              <Pressable
                disabled={disabled}
                key={key}
                onPress={() => taskModel.setListKey(key)}
                style={styles.calendarRow}
                testID="task-list-option"
              >
                {list.colorHex ? (
                  <View style={[styles.swatch, { backgroundColor: list.colorHex }]} />
                ) : null}
                <Text style={[styles.calendarName, selected && styles.calendarSelected]}>
                  {list.title}
                </Text>
                {selected ? <Text style={styles.check}>✓</Text> : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </>
  );
}
