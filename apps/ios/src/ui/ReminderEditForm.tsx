import {
  REMINDER_ALARM_OPTIONS,
  REMINDER_PRIORITY_OPTIONS,
  type useTaskEditorModel,
} from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import {
  chip,
  chipLabel,
  dateFromParts,
  useSheetStyles,
  toDateString,
  toTimeString,
} from './editSheetShared.ts';
import { DueLabel, NoDueDate } from './NoDueDate.tsx';
import { RepeatRuleChips } from './RepeatRuleChips.tsx';
import { TaskListPicker } from './TaskListPicker.tsx';

/**
 * The Reminders half of the task editor — what EventKit can do that Google
 * Tasks cannot: a due time, priority, URL, an alarm, a repeat rule, and
 * moving between lists. Shares the title/list/delete testIDs with the
 * Google form so the shell and the Maestro flows stay provider-agnostic.
 */
export function ReminderEditForm({
  autoFocusTitle = true,
  task,
  taskModel,
}: {
  /** Off when the quick-add field above the form takes the focus. */
  autoFocusTitle?: boolean;
  task: TaskRecord | undefined;
  taskModel: ReturnType<typeof useTaskEditorModel>;
}) {
  const styles = useSheetStyles();
  return (
    // Keyboard insets: the quick-add field on top of a new item keeps the
    // keyboard up, and the lower rows must still scroll into reach.
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[styles.content, taskModel.readOnly && styles.readOnly]}
      keyboardShouldPersistTaps="handled"
      pointerEvents={taskModel.readOnly ? 'none' : 'auto'}
    >
      {taskModel.error ? <Text style={styles.error}>{taskModel.error}</Text> : null}
      {taskModel.readOnly ? (
        <Text style={styles.readOnlyNote}>This list is read-only in Reminders.</Text>
      ) : null}
      <TextInput
        autoFocus={autoFocusTitle && !task}
        onChangeText={taskModel.setTitle}
        placeholder="Title"
        style={styles.input}
        testID="task-title"
        value={taskModel.title}
      />

      <TaskListPicker disabled={Boolean(task) && !taskModel.canMoveList} taskModel={taskModel} />

      {taskModel.dated ? (
        <>
          <View style={styles.pickerRow}>
            <DueLabel onRemove={taskModel.clearDueDate} />
            <DateTimePicker
              display="compact"
              mode="date"
              onChange={(_, picked) => picked && taskModel.setDueDate(toDateString(picked))}
              value={dateFromParts(taskModel.dueDate)}
            />
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.label}>At a time</Text>
            <Switch
              onValueChange={taskModel.setTimed}
              testID="reminder-timed"
              value={taskModel.timed}
            />
          </View>
          {taskModel.timed ? (
            <View style={styles.pickerRow} testID="reminder-time">
              <Text style={styles.label}>Time</Text>
              <DateTimePicker
                display="compact"
                mode="time"
                onChange={(_, picked) => picked && taskModel.setDueTime(toTimeString(picked))}
                value={dateFromParts(taskModel.dueDate, taskModel.dueTime)}
              />
            </View>
          ) : null}
        </>
      ) : (
        <NoDueDate onAdd={taskModel.addDueDate} />
      )}

      <Text style={styles.label}>Priority</Text>
      <View style={styles.scopeRow}>
        {REMINDER_PRIORITY_OPTIONS.map((option) => (
          <Pressable
            key={option.label}
            onPress={() => taskModel.setPriority(option.value)}
            style={chip(styles, taskModel.priority === option.value)}
            testID={`reminder-priority-${option.value ?? 'none'}`}
          >
            <Text style={chipLabel(styles, taskModel.priority === option.value)}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Alert</Text>
      <View style={styles.scopeRow}>
        {REMINDER_ALARM_OPTIONS.map((option) => (
          <Pressable
            key={option.label}
            onPress={() => taskModel.setAlarm(option.value)}
            style={chip(styles, taskModel.alarm === option.value)}
            testID={`reminder-alarm-${option.value ?? 'none'}`}
          >
            <Text style={chipLabel(styles, taskModel.alarm === option.value)}>{option.label}</Text>
          </Pressable>
        ))}
      </View>

      {taskModel.recurrenceUnsupported ? (
        <>
          <Text style={styles.label}>Repeat</Text>
          <Text style={styles.hint}>
            This reminder repeats on a schedule Solunivo cannot edit — change it in Reminders.
          </Text>
        </>
      ) : (
        <RepeatRuleChips
          anchorDate={taskModel.dueDate}
          state={taskModel}
          testIDPrefix="reminder-repeat"
        />
      )}

      <Text style={styles.label}>URL</Text>
      <TextInput
        autoCapitalize="none"
        keyboardType="url"
        onChangeText={taskModel.setUrl}
        placeholder="https://"
        style={styles.input}
        testID="reminder-url"
        value={taskModel.url}
      />

      <Text style={styles.label}>Notes</Text>
      <TextInput
        multiline
        numberOfLines={3}
        onChangeText={taskModel.setNotes}
        placeholder="Add notes"
        style={[styles.input, styles.notesInput]}
        value={taskModel.notes}
      />

      {task ? (
        <Pressable onPress={() => void Linking.openURL('x-apple-reminderkit://')}>
          <Text style={styles.webLink}>Open Reminders</Text>
        </Pressable>
      ) : null}

      {task && !taskModel.readOnly ? (
        <Pressable
          onPress={() => void taskModel.remove()}
          style={[styles.deleteButton, taskModel.busy && styles.busy]}
          testID="task-delete"
        >
          <Text style={styles.deleteLabel}>Delete Reminder</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
