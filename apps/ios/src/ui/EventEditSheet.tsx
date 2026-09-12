import { useEventEditorModel, useTaskEditorModel, type EventEditorSeed } from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  type CalendarInfo,
  type TaskListInfo,
  type TaskRecord,
} from '@calendar/core';
import { useState } from 'react';
import { Modal, Pressable, SafeAreaView, Text, View } from 'react-native';
import { BirthdayDetail } from './BirthdayDetail.tsx';
import { sheetStyles as styles } from './editSheetShared.ts';
import { EventEditForm } from './EventEditForm.tsx';
import { ReminderEditForm } from './ReminderEditForm.tsx';
import { TaskEditForm } from './TaskEditForm.tsx';

export type EditSeed = EventEditorSeed;

/**
 * Modal shell for creating/editing events and tasks. The two forms live in
 * EventEditForm/TaskEditForm; this file owns the mode toggle, the header,
 * and both editor models (state must survive a mode flip).
 */
export function EventEditSheet({
  birthday,
  calendars,
  onClose,
  seed,
  task,
  taskLists,
  timeZone,
}: {
  /** Present when opened from a birthday chip: a read-only detail, nothing to edit. */
  birthday?: BirthdayOccurrence | undefined;
  calendars: ReadonlyArray<CalendarInfo>;
  onClose: () => void;
  seed: EditSeed;
  /** Present when the sheet was opened from a task chip (task edit mode). */
  task?: TaskRecord | undefined;
  taskLists: ReadonlyArray<TaskListInfo>;
  timeZone: string;
}) {
  // Create mode offers an Event | Task toggle; a chip tap fixes the mode.
  const [mode, setMode] = useState<'birthday' | 'event' | 'task'>(
    birthday ? 'birthday' : task ? 'task' : 'event',
  );
  const taskModel = useTaskEditorModel({
    onClose,
    seed: { existing: task, initialDate: seed.initialDate.toString() },
    taskLists,
  });
  const eventModel = useEventEditorModel({ calendars, onClose, seed, timeZone });

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      visible
    >
      {/* overFullScreen draws under the status bar; inset it ourselves. */}
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onClose}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>
            {mode === 'birthday'
              ? 'Birthday'
              : mode === 'task'
                ? task
                  ? taskModel.provider === 'apple'
                    ? 'Edit Reminder'
                    : 'Edit Task'
                  : 'New Task'
                : eventModel.existing
                  ? 'Edit Event'
                  : 'New Event'}
          </Text>
          {mode === 'birthday' || (mode === 'task' && taskModel.readOnly) ? (
            <View />
          ) : (
            <Pressable
              onPress={() => void (mode === 'task' ? taskModel.save() : eventModel.save())}
              testID="event-save"
            >
              <Text style={styles.save}>Save</Text>
            </Pressable>
          )}
        </View>

        {!eventModel.existing && !task && !birthday ? (
          <View style={styles.modeRow}>
            {(['event', 'task'] as const).map((option) => (
              <Pressable
                key={option}
                onPress={() => setMode(option)}
                style={[styles.scopeChip, mode === option && styles.scopeChipActive]}
                testID={`mode-${option}`}
              >
                <Text style={[styles.scopeLabel, mode === option && styles.scopeLabelActive]}>
                  {option === 'event' ? 'Event' : 'Task'}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {mode === 'birthday' && birthday ? (
          <BirthdayDetail occurrence={birthday} timeZone={timeZone} />
        ) : mode === 'task' ? (
          // The selected list's provider picks the form: a Reminders list
          // exposes time/priority/alert/repeat/URL and can move; a Google
          // list gets the plain title/date/notes form.
          taskModel.provider === 'apple' ? (
            <ReminderEditForm task={task} taskModel={taskModel} />
          ) : (
            <TaskEditForm task={task} taskModel={taskModel} />
          )
        ) : (
          <EventEditForm model={eventModel} />
        )}
      </SafeAreaView>
    </Modal>
  );
}
