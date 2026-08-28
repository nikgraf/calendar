import type { useTaskEditorModel } from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { dateFromParts, sheetStyles as styles, toDateString } from './editSheetShared.ts';

/** The task half of EventEditSheet (mode === 'task'). */
export function TaskEditForm({
  task,
  taskModel,
}: {
  task: TaskRecord | undefined;
  taskModel: ReturnType<typeof useTaskEditorModel>;
}) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {taskModel.error ? <Text style={styles.error}>{taskModel.error}</Text> : null}
      <TextInput
        autoFocus={!task}
        onChangeText={taskModel.setTitle}
        placeholder="Title"
        style={styles.input}
        testID="task-title"
        value={taskModel.title}
      />

      <View style={styles.pickerRow}>
        <Text style={styles.label}>Due</Text>
        <DateTimePicker
          display="compact"
          mode="date"
          onChange={(_, picked) => picked && taskModel.setDueDate(toDateString(picked))}
          value={dateFromParts(taskModel.dueDate)}
        />
      </View>

      <Text style={styles.label}>List</Text>
      {taskModel.taskLists.map((list) => {
        const key = `${list.accountId}:${list.id}`;
        const selected = key === taskModel.listKey;
        return (
          <Pressable
            // The list is fixed after create — moving needs tasks.move.
            disabled={Boolean(task)}
            key={key}
            onPress={() => taskModel.setListKey(key)}
            style={styles.calendarRow}
            testID="task-list-option"
          >
            <Text style={[styles.calendarName, selected && styles.calendarSelected]}>
              {list.title}
            </Text>
            {selected ? <Text style={styles.check}>✓</Text> : null}
          </Pressable>
        );
      })}

      <Text style={styles.label}>Notes</Text>
      <TextInput
        multiline
        numberOfLines={3}
        onChangeText={taskModel.setNotes}
        placeholder="Add notes"
        style={[styles.input, styles.notesInput]}
        value={taskModel.notes}
      />

      {task?.webViewLink ? (
        <Pressable onPress={() => void Linking.openURL(task.webViewLink ?? '')}>
          <Text style={styles.webLink}>Open in Google Tasks</Text>
        </Pressable>
      ) : null}

      {task ? (
        <Pressable
          onPress={() => void taskModel.remove()}
          style={styles.deleteButton}
          testID="task-delete"
        >
          <Text style={styles.deleteLabel}>Delete Task</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
