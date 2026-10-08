import type { useTaskEditorModel } from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { dateFromParts, useSheetStyles, toDateString } from './editSheetShared.ts';
import { NoDueDate } from './NoDueDate.tsx';
import { TaskListPicker } from './TaskListPicker.tsx';

/** The task half of EventEditSheet (mode === 'task'). */
export function TaskEditForm({
  task,
  taskModel,
}: {
  task: TaskRecord | undefined;
  taskModel: ReturnType<typeof useTaskEditorModel>;
}) {
  const styles = useSheetStyles();
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

      {taskModel.dated ? (
        <View style={styles.pickerRow}>
          <Text style={styles.label}>Due</Text>
          <DateTimePicker
            display="compact"
            mode="date"
            onChange={(_, picked) => picked && taskModel.setDueDate(toDateString(picked))}
            value={dateFromParts(taskModel.dueDate)}
          />
        </View>
      ) : (
        <NoDueDate onAdd={taskModel.addDueDate} />
      )}

      <TaskListPicker disabled={Boolean(task) && !taskModel.canMoveList} taskModel={taskModel} />

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
          style={[styles.deleteButton, taskModel.busy && styles.busy]}
          testID="task-delete"
        >
          <Text style={styles.deleteLabel}>Delete Task</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
