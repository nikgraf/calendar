import type { useTaskEditorModel } from '@calendar/app-state';
import type { TaskRecord } from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Linking, Text } from 'react-native';
import { dateFromParts, useSheetStyles, toDateString } from './editSheetShared.ts';
import { FieldFlash } from './FlashView.tsx';
import { FormScroll } from './FormScroll.tsx';
import { ActionRow, FieldRow, Section } from './GroupedList.tsx';
import { DueRow, NoDueDate } from './NoDueDate.tsx';
import { TaskListPicker } from './TaskListPicker.tsx';

/**
 * The task half of EventEditSheet (mode === 'task'), as grouped cards in
 * Reminders' own order: title and notes; the due day; the list; Delete.
 */
export function TaskEditForm({
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
    <FormScroll bare={bare} contentStyle={styles.content}>
      {taskModel.error ? (
        <Text selectable style={styles.formError}>
          {taskModel.error}
        </Text>
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
        <FieldFlash bleedX={0} bleedY={0} field="notes" radius={0}>
          <FieldRow
            multiline
            onChangeText={taskModel.setNotes}
            placeholder="Notes"
            value={taskModel.notes}
          />
        </FieldFlash>
      </Section>

      <Section tight>
        {taskModel.dated ? (
          <FieldFlash bleedX={0} bleedY={0} field="date" radius={0}>
            <DueRow onRemove={taskModel.clearDueDate}>
              <DateTimePicker
                display="compact"
                mode="date"
                onChange={(_, picked) => picked && taskModel.setDueDate(toDateString(picked))}
                value={dateFromParts(taskModel.dueDate)}
              />
            </DueRow>
          </FieldFlash>
        ) : (
          <NoDueDate onAdd={taskModel.addDueDate} />
        )}
      </Section>

      <TaskListPicker disabled={Boolean(task) && !taskModel.canMoveList} taskModel={taskModel} />

      {task?.webViewLink ? (
        <Section tight>
          <ActionRow
            onPress={() => void Linking.openURL(task.webViewLink ?? '')}
            title="Open in Google Tasks"
          />
        </Section>
      ) : null}

      {task ? (
        <Section tight>
          <ActionRow
            disabled={taskModel.busy}
            onPress={() => void taskModel.remove()}
            testID="task-delete"
            title="Delete Task"
            tone="destructive"
          />
        </Section>
      ) : null}
    </FormScroll>
  );
}
