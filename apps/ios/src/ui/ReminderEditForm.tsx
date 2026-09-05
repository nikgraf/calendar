import {
  REMINDER_ALARM_OPTIONS,
  REMINDER_PRIORITY_OPTIONS,
  type useTaskEditorModel,
} from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import {
  dateFromParts,
  REPEAT_ENDS,
  REPEATS,
  sheetStyles as styles,
  toDateString,
  toTimeString,
} from './editSheetShared.ts';

const chip = (active: boolean) => [styles.scopeChip, active && styles.scopeChipActive];
const chipLabel = (active: boolean) => [styles.scopeLabel, active && styles.scopeLabelActive];

/**
 * The Reminders half of the task editor — what EventKit can do that Google
 * Tasks cannot: a due time, priority, URL, an alarm, a repeat rule, and
 * moving between lists. Shares the title/list/delete testIDs with the
 * Google form so the shell and the Maestro flows stay provider-agnostic.
 */
export function ReminderEditForm({
  task,
  taskModel,
}: {
  task: TaskRecord | undefined;
  taskModel: ReturnType<typeof useTaskEditorModel>;
}) {
  return (
    <ScrollView
      contentContainerStyle={[styles.content, taskModel.readOnly && styles.readOnly]}
      pointerEvents={taskModel.readOnly ? 'none' : 'auto'}
    >
      {taskModel.error ? <Text style={styles.error}>{taskModel.error}</Text> : null}
      {taskModel.readOnly ? (
        <Text style={styles.readOnlyNote}>This list is read-only in Reminders.</Text>
      ) : null}
      <TextInput
        autoFocus={!task}
        onChangeText={taskModel.setTitle}
        placeholder="Title"
        style={styles.input}
        testID="task-title"
        value={taskModel.title}
      />

      <Text style={styles.label}>List</Text>
      {taskModel.taskLists.map((list) => {
        const key = `${list.accountId}:${list.id}`;
        const selected = key === taskModel.listKey;
        return (
          <Pressable
            // Reminders can move between lists (EKReminder.calendar is settable).
            disabled={Boolean(task) && !taskModel.canMoveList}
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

      <View style={styles.pickerRow}>
        <Text style={styles.label}>Due</Text>
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

      <Text style={styles.label}>Priority</Text>
      <View style={styles.scopeRow}>
        {REMINDER_PRIORITY_OPTIONS.map((option) => (
          <Pressable
            key={option.label}
            onPress={() => taskModel.setPriority(option.value)}
            style={chip(taskModel.priority === option.value)}
            testID={`reminder-priority-${option.value ?? 'none'}`}
          >
            <Text style={chipLabel(taskModel.priority === option.value)}>{option.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Alert</Text>
      <View style={styles.scopeRow}>
        {REMINDER_ALARM_OPTIONS.map((option) => (
          <Pressable
            key={option.label}
            onPress={() => taskModel.setAlarm(option.value)}
            style={chip(taskModel.alarm === option.value)}
            testID={`reminder-alarm-${option.value ?? 'none'}`}
          >
            <Text style={chipLabel(taskModel.alarm === option.value)}>{option.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Repeat</Text>
      {taskModel.recurrenceUnsupported ? (
        <Text style={styles.hint}>
          This reminder repeats on a schedule Solunivo cannot edit — change it in Reminders.
        </Text>
      ) : (
        <>
          <View style={styles.scopeRow}>
            {REPEATS.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => taskModel.setRepeat(option.value)}
                style={chip(taskModel.repeat === option.value)}
                testID={`reminder-repeat-${option.value}`}
              >
                <Text style={chipLabel(taskModel.repeat === option.value)}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
          {taskModel.repeat === 'none' ? null : (
            <View style={styles.timesRow}>
              <View style={styles.timeField}>
                <Text style={styles.label}>Every (n)</Text>
                <TextInput
                  keyboardType="number-pad"
                  onChangeText={taskModel.setRepeatInterval}
                  style={styles.input}
                  value={taskModel.repeatInterval}
                />
              </View>
              <View style={styles.timeField}>
                <Text style={styles.label}>Ends</Text>
                <View style={styles.scopeRow}>
                  {REPEAT_ENDS.map((option) => (
                    <Pressable
                      key={option.value}
                      onPress={() => {
                        taskModel.setRepeatEnds(option.value);
                        if (option.value === 'on' && !taskModel.repeatUntil) {
                          taskModel.setRepeatUntil(taskModel.dueDate);
                        }
                      }}
                      style={chip(taskModel.repeatEnds === option.value)}
                    >
                      <Text style={chipLabel(taskModel.repeatEnds === option.value)}>
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>
          )}
          {taskModel.repeat !== 'none' && taskModel.repeatEnds === 'after' ? (
            <View style={styles.timeField}>
              <Text style={styles.label}>Occurrences</Text>
              <TextInput
                keyboardType="number-pad"
                onChangeText={taskModel.setRepeatCount}
                style={styles.input}
                value={taskModel.repeatCount}
              />
            </View>
          ) : null}
          {taskModel.repeat !== 'none' && taskModel.repeatEnds === 'on' ? (
            <View style={styles.pickerRow}>
              <Text style={styles.label}>Until</Text>
              <DateTimePicker
                display="compact"
                mode="date"
                onChange={(_, picked) => picked && taskModel.setRepeatUntil(toDateString(picked))}
                value={dateFromParts(taskModel.repeatUntil || taskModel.dueDate)}
              />
            </View>
          ) : null}
        </>
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
          style={styles.deleteButton}
          testID="task-delete"
        >
          <Text style={styles.deleteLabel}>Delete Reminder</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
