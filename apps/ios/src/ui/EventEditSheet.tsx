import {
  type EditorConfirmRequest,
  type EditorSourceKind,
  switchEditorMode,
  useBackendMutations,
  useEventEditorModel,
  useTaskEditorModel,
  type EventEditorSeed,
  type TaskEditorSeed,
} from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  type CalendarInfo,
  type TaskListInfo,
  type TaskRecord,
} from '@calendar/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, SafeAreaView, Text, View } from 'react-native';
import { BirthdayDetail } from './BirthdayDetail.tsx';
import { useSheetStyles } from './editSheetShared.ts';
import { EventEditForm } from './EventEditForm.tsx';
import { ReminderEditForm } from './ReminderEditForm.tsx';
import { TaskEditForm } from './TaskEditForm.tsx';

export type EditSeed = EventEditorSeed;

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The alert for a move, conversion or create-mode switch that drops
 * something (guests, a due time…), and for a delete, whose summary is the
 * whole question.
 */
const wording = (
  request: EditorConfirmRequest,
): {
  readonly message: string | undefined;
  readonly no: string;
  readonly title: string;
  readonly yes: string;
} => {
  const subject = capitalize(request.subject);
  const other = request.subject === 'event' ? 'task' : 'event';
  switch (request.kind) {
    case 'move':
      return {
        message: request.summary,
        no: 'Keep Here',
        title: `Move ${request.subject}?`,
        yes: 'Move',
      };
    case 'convert':
      return {
        message: request.summary,
        no: `Keep as ${subject}`,
        title: `Convert ${request.subject}?`,
        yes: 'Convert',
      };
    case 'switch':
      return {
        message: request.summary,
        no: `Keep as ${subject}`,
        title: `Switch to ${other}?`,
        yes: 'Switch',
      };
    case 'delete':
      return { message: undefined, no: 'Cancel', title: request.summary, yes: 'Delete' };
  }
};
/** The native alert for an editor's lossy move, conversion, switch or delete. */
export const confirmEditorRequest = (request: EditorConfirmRequest): Promise<boolean> =>
  new Promise((resolve) => {
    const { message, no, title, yes } = wording(request);
    Alert.alert(title, message, [
      { onPress: () => resolve(false), style: 'cancel', text: no },
      { onPress: () => resolve(true), style: 'destructive', text: yes },
    ]);
  });

/**
 * Modal shell for creating/editing events and tasks. The two forms live in
 * EventEditForm/TaskEditForm; this file owns the mode toggle, the header,
 * and both editor models (state must survive a mode flip).
 */
export function EventEditSheet({
  birthday,
  calendars,
  initialMode,
  onClose,
  onSaved,
  seed,
  task,
  taskLists,
  taskPrefill,
  timeZone,
}: {
  /** Present when opened from a birthday chip: a read-only detail, nothing to edit. */
  birthday?: BirthdayOccurrence | undefined;
  calendars: ReadonlyArray<CalendarInfo>;
  /** Open on the task form: the detail sheet's Convert. */
  initialMode?: 'task' | undefined;
  onClose: () => void;
  /** Save went through, as an event or a task (capture marks its row added). */
  onSaved?: (() => void) | undefined;
  seed: EditSeed;
  /** Present when the sheet was opened from a task chip (task edit mode). */
  task?: TaskRecord | undefined;
  taskLists: ReadonlyArray<TaskListInfo>;
  /** A new task to open with (a quick-add phrase understood as a task). */
  taskPrefill?: Pick<TaskEditorSeed, 'dated' | 'initialTime' | 'title'> | undefined;
  timeZone: string;
}) {
  const styles = useSheetStyles();
  const sourceKind: EditorSourceKind = birthday
    ? 'birthday'
    : task
      ? 'task'
      : seed.event
        ? 'event'
        : 'new';
  // The Event | Task toggle: in create mode it picks the kind, on an
  // existing item it converts (Save then writes the other kind and
  // deletes the source). Both models stay mounted so a flip keeps state.
  // An existing event asked to open as a task (the detail sheet's Convert)
  // still starts as the event and switches below: the switch is what
  // carries the title, notes, rule and URL over and asks about a loss.
  const convertOnOpen = initialMode === 'task' && sourceKind === 'event';
  const [mode, setMode] = useState<'birthday' | 'event' | 'task'>(
    birthday ? 'birthday' : task || taskPrefill ? 'task' : 'event',
  );
  const mutations = useBackendMutations();
  const taskModel = useTaskEditorModel({
    confirm: confirmEditorRequest,
    onClose,
    onSaved,
    seed: {
      convertFromEvent: seed.event,
      dated: taskPrefill?.dated,
      existing: task,
      initialDate: seed.initialDate.toString(),
      initialTime: taskPrefill?.initialTime ?? seed.initialTimes?.startTime,
      title: taskPrefill?.title,
    },
    taskLists,
  });
  const eventModel = useEventEditorModel({
    calendars,
    confirm: confirmEditorRequest,
    onClose,
    onSaved,
    seed: { ...seed, convertFromTask: task },
    timeZone,
  });

  const switchTo = useCallback(
    async (next: 'event' | 'task') => {
      if (next === mode) {
        return;
      }
      const switched = await switchEditorMode({
        confirm: confirmEditorRequest,
        eventModel,
        next,
        previewEventToTask: mutations.previewEventToTask,
        sourceKind,
        taskModel,
        timeZone,
      });
      if (switched) {
        setMode(next);
      }
    },
    [eventModel, mode, mutations.previewEventToTask, sourceKind, taskModel, timeZone],
  );
  const converted = useRef(false);
  useEffect(() => {
    if (convertOnOpen && !converted.current) {
      converted.current = true;
      void switchTo('task');
    }
  }, [convertOnOpen, switchTo]);
  const showToggle =
    mode !== 'birthday' &&
    !(sourceKind === 'event' && eventModel.readOnly) &&
    !(sourceKind === 'task' && taskModel.readOnly);
  // A series converts as a whole, like it moves: an occurrence-scoped edit stays an event.
  const seriesOnly =
    sourceKind === 'event' && eventModel.isRecurring && eventModel.scope !== 'series';
  const taskWord = taskModel.provider === 'apple' ? 'Reminder' : 'Task';
  const busy = mode === 'task' ? taskModel.busy : eventModel.busy;
  const title =
    mode === 'birthday'
      ? 'Birthday'
      : mode === 'task'
        ? sourceKind === 'event'
          ? `Convert to ${taskWord}`
          : task
            ? `Edit ${taskWord}`
            : 'New Task'
        : sourceKind === 'task'
          ? 'Convert to Event'
          : eventModel.existing
            ? 'Edit Event'
            : 'New Event';

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      {/* A page sheet sits below the status bar; the SafeAreaView adds no
          top inset there, and only wraps the header: the form's ScrollView
          runs to the bottom edge and pads its own content past the home
          indicator, so its last control is never clipped by a bottom inset
          while still reporting an on-screen frame — a tap there used to
          land on nothing (CI flows 08/16). */}
      <View style={styles.container}>
        <SafeAreaView>
          <View style={styles.header}>
            <Pressable onPress={onClose}>
              {/* A birthday's reminder chips save as they change: nothing to cancel. */}
              <Text style={styles.cancel}>{mode === 'birthday' ? 'Done' : 'Cancel'}</Text>
            </Pressable>
            <Text style={styles.title}>{title}</Text>
            {mode === 'birthday' ||
            (mode === 'task' && taskModel.readOnly) ||
            (mode === 'event' && eventModel.readOnly) ? (
              <View />
            ) : (
              <Pressable
                onPress={() => void (mode === 'task' ? taskModel.save() : eventModel.save())}
                style={busy ? styles.busy : undefined}
                testID="event-save"
              >
                <Text style={styles.save}>Save</Text>
              </Pressable>
            )}
          </View>

          {showToggle ? (
            <View style={styles.modeRow}>
              {(['event', 'task'] as const).map((option) => {
                const disabled = option === 'task' && seriesOnly;
                return (
                  <Pressable
                    disabled={disabled}
                    key={option}
                    onPress={() => void switchTo(option)}
                    style={[
                      styles.scopeChip,
                      mode === option && styles.scopeChipActive,
                      disabled && styles.scopeChipDisabled,
                    ]}
                    testID={`mode-${option}`}
                  >
                    <Text style={[styles.scopeLabel, mode === option && styles.scopeLabelActive]}>
                      {option === 'event' ? 'Event' : 'Task'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </SafeAreaView>
        {mode === 'birthday' && birthday ? (
          <BirthdayDetail occurrence={birthday} timeZone={timeZone} />
        ) : mode === 'task' ? (
          // The selected list's provider picks the form: a Reminders list
          // exposes time/priority/alert/repeat/URL; a Google list gets the
          // plain title/date/notes form. Either list can be in another
          // account or provider — Save then moves the task.
          taskModel.provider === 'apple' ? (
            <ReminderEditForm task={task} taskModel={taskModel} />
          ) : (
            <TaskEditForm task={task} taskModel={taskModel} />
          )
        ) : (
          <EventEditForm model={eventModel} />
        )}
      </View>
    </Modal>
  );
}
