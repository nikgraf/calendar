import {
  REMINDER_ALARM_OPTIONS,
  REMINDER_PRIORITY_OPTIONS,
  type useTaskEditorModel,
} from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Linking, Text } from 'react-native';
import { Chip } from './Chip.tsx';
import { dateFromParts, useSheetStyles, toDateString, toTimeString } from './editSheetShared.ts';
import { FieldFlash } from './FlashView.tsx';
import { FormScroll } from './FormScroll.tsx';
import { ActionRow, ChipsRow, FieldRow, Row, Section, SwitchRow } from './GroupedList.tsx';
import { DueRow, NoDueDate } from './NoDueDate.tsx';
import { RepeatRuleChips } from './RepeatRuleChips.tsx';
import { TaskListPicker } from './TaskListPicker.tsx';

/**
 * The Reminders half of the task editor — what EventKit can do that Google
 * Tasks cannot: a due time, priority, URL, an alarm, a repeat rule, and
 * moving between lists — as grouped cards in Reminders' own order: title
 * and notes; the list; the due day and time; the repeat rule; priority,
 * alert and URL; Delete. Shares the title/list/delete testIDs with the
 * Google form so the shell and the Maestro flows stay provider-agnostic.
 */
export function ReminderEditForm({
  autoFocusTitle = true,
  bare,
  task,
  taskModel,
}: {
  /** Off when the quick-add field above the form takes the focus. */
  autoFocusTitle?: boolean;
  /** The content only: the sheet around it owns the scroll view (`FormScroll`). */
  bare?: boolean | undefined;
  task: TaskRecord | undefined;
  taskModel: ReturnType<typeof useTaskEditorModel>;
}) {
  const styles = useSheetStyles();
  return (
    <FormScroll
      bare={bare}
      contentStyle={[styles.content, taskModel.readOnly && styles.readOnly]}
      pointerEvents={taskModel.readOnly ? 'none' : 'auto'}
    >
      {taskModel.error ? (
        <Text selectable style={styles.formError}>
          {taskModel.error}
        </Text>
      ) : null}
      {taskModel.readOnly ? (
        <Text style={styles.formNote}>This list is read-only in Reminders.</Text>
      ) : null}
      <Section tight>
        <FieldFlash bleedX={0} bleedY={0} field="title" radius={0}>
          <FieldRow
            autoFocus={autoFocusTitle && !task}
            onChangeText={taskModel.setTitle}
            placeholder="Title"
            testID="task-title"
            value={taskModel.title}
          />
        </FieldFlash>
        <FieldRow
          multiline
          onChangeText={taskModel.setNotes}
          placeholder="Notes"
          value={taskModel.notes}
        />
      </Section>

      <TaskListPicker disabled={Boolean(task) && !taskModel.canMoveList} taskModel={taskModel} />

      <Section tight>
        {taskModel.dated ? (
          <FieldFlash bleedX={0} bleedY={0} field="date" radius={0}>
            <DueRow onRemove={taskModel.clearDueDate}>
              <DateTimePicker
                display="compact"
                mode="date"
                onValueChange={(_, picked) => taskModel.setDueDate(toDateString(picked))}
                value={dateFromParts(taskModel.dueDate)}
              />
            </DueRow>
          </FieldFlash>
        ) : (
          <NoDueDate onAdd={taskModel.addDueDate} />
        )}
        {taskModel.dated ? (
          <SwitchRow
            onValueChange={taskModel.setTimed}
            switchTestID="reminder-timed"
            title="At a time"
            value={taskModel.timed}
          />
        ) : null}
        {taskModel.dated && taskModel.timed ? (
          <FieldFlash bleedX={0} bleedY={0} field="time" radius={0} testID="reminder-time">
            <Row
              accessory={
                <DateTimePicker
                  display="compact"
                  mode="time"
                  onValueChange={(_, picked) => taskModel.setDueTime(toTimeString(picked))}
                  value={dateFromParts(taskModel.dueDate, taskModel.dueTime)}
                />
              }
              title="Time"
            />
          </FieldFlash>
        ) : null}
      </Section>

      {taskModel.recurrenceUnsupported ? (
        <Section
          footer="This reminder repeats on a schedule Solunivo cannot edit — change it in Reminders."
          header="Repeat"
          tight
        />
      ) : taskModel.dated ? (
        // Only a reminder with a due day repeats.
        <RepeatRuleChips
          anchorDate={taskModel.dueDate}
          state={taskModel}
          testIDPrefix="reminder-repeat"
        />
      ) : null}

      <Section tight>
        <ChipsRow label="Priority">
          {REMINDER_PRIORITY_OPTIONS.map((option) => (
            <Chip
              key={option.label}
              label={option.label}
              onPress={() => taskModel.setPriority(option.value)}
              selected={taskModel.priority === option.value}
              testID={`reminder-priority-${option.value ?? 'none'}`}
            />
          ))}
        </ChipsRow>
        <ChipsRow label="Alert">
          {REMINDER_ALARM_OPTIONS.map((option) => (
            <Chip
              key={option.label}
              label={option.label}
              onPress={() => taskModel.setAlarm(option.value)}
              selected={taskModel.alarm === option.value}
              testID={`reminder-alarm-${option.value ?? 'none'}`}
            />
          ))}
        </ChipsRow>
        <FieldRow
          autoCapitalize="none"
          keyboardType="url"
          onChangeText={taskModel.setUrl}
          placeholder="URL"
          testID="reminder-url"
          value={taskModel.url}
        />
      </Section>

      {task ? (
        <Section tight>
          <ActionRow
            onPress={() => void Linking.openURL('x-apple-reminderkit://')}
            title="Open Reminders"
          />
        </Section>
      ) : null}

      {task && !taskModel.readOnly ? (
        <Section tight>
          <ActionRow
            disabled={taskModel.busy}
            onPress={() => void taskModel.remove()}
            testID="task-delete"
            title="Delete Reminder"
            tone="destructive"
          />
        </Section>
      ) : null}
    </FormScroll>
  );
}
