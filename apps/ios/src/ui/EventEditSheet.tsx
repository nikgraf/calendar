import {
  type EditorConfirmRequest,
  type EditorSourceKind,
  editorTitle,
  useBackendMutations,
  useEditorKinds,
  useEventEditorModel,
  useTaskEditorModel,
  type EventEditorSeed,
  type TaskEditorSeed,
} from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  type CalendarInfo,
  type ItemKind,
  type TaskListInfo,
  type TaskRecord,
} from '@calendar/core';
import { Alert, Modal, Pressable, SafeAreaView, Text, View } from 'react-native';
import { BirthdayDetail } from './BirthdayDetail.tsx';
import { useSheetStyles } from './editSheetShared.ts';
import { EventEditForm } from './EventEditForm.tsx';
import { QuickAddBar } from './QuickAddBar.tsx';
import { ReminderEditForm } from './ReminderEditForm.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';
import { TaskEditForm } from './TaskEditForm.tsx';
import { BOX_FONT_SCALE } from './theme.ts';

export type EditSeed = EventEditorSeed;

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

const KIND_LABELS: Record<ItemKind, string> = {
  event: 'Event',
  reminder: 'Reminder',
  task: 'Task',
};

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
  const other = request.target ?? (request.subject === 'event' ? 'task' : 'event');
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
 * Modal shell for creating/editing events, tasks and reminders. For a new
 * item the quick-add field sits on top, then the Event | Task | Reminder
 * control (only the kinds something can hold), then the form. The forms
 * live in EventEditForm / TaskEditForm / ReminderEditForm; this file owns
 * the header and both editor models (state must survive a kind flip).
 */
export function EventEditSheet({
  birthday,
  calendars,
  initialKind,
  onClose,
  onSaved,
  seed,
  task,
  taskLists,
  taskSeed,
  timeZone,
}: {
  /** Present when opened from a birthday chip: a read-only detail, nothing to edit. */
  birthday?: BirthdayOccurrence | undefined;
  calendars: ReadonlyArray<CalendarInfo>;
  /** The kind to open on: a to-do for the Tasks tab's "+", or the detail sheet's Convert. */
  initialKind?: ItemKind | undefined;
  onClose: () => void;
  /** Save went through, as an event or a task (capture marks its row added). */
  onSaved?: (() => void) | undefined;
  seed: EditSeed;
  /** Present when the sheet was opened from a task chip (task edit mode). */
  task?: TaskRecord | undefined;
  taskLists: ReadonlyArray<TaskListInfo>;
  /** A new to-do's start: undated (the Tasks tab's "+") and the list to open in. */
  taskSeed?: Pick<TaskEditorSeed, 'dated' | 'listKey'> | undefined;
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
  const mutations = useBackendMutations();
  const taskModel = useTaskEditorModel({
    confirm: confirmEditorRequest,
    onClose,
    onSaved,
    seed: {
      convertFromEvent: seed.event,
      dated: taskSeed?.dated,
      existing: task,
      initialDate: seed.initialDate.toString(),
      initialTime: seed.initialTimes?.startTime,
      kind: initialKind === 'event' ? undefined : initialKind,
      listKey: taskSeed?.listKey,
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
  const { apply, available, kind, mode, seriesOnly, switchTo } = useEditorKinds({
    calendars,
    confirm: confirmEditorRequest,
    eventModel,
    initialKind,
    previewEventToTask: mutations.previewEventToTask,
    sourceKind,
    taskLists,
    taskModel,
    timeZone,
  });

  const showToggle =
    !birthday &&
    available.length > 1 &&
    !(sourceKind === 'event' && eventModel.readOnly) &&
    !(sourceKind === 'task' && taskModel.readOnly);
  const busy = mode === 'todo' ? taskModel.busy : eventModel.busy;
  // A new item: the quick-add field on top takes the focus, not the title.
  const quickAdd = sourceKind === 'new';
  const { noun, verb } = editorTitle({ kind, sourceKind, sourceProvider: task?.provider });
  const title = birthday ? 'Birthday' : `${verb} ${capitalize(noun)}`;

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
              <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.cancel}>
                {birthday ? 'Done' : 'Cancel'}
              </Text>
            </Pressable>
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.title}>
              {title}
            </Text>
            {birthday ||
            (mode === 'todo' && taskModel.readOnly) ||
            (mode === 'event' && eventModel.readOnly) ? (
              <View />
            ) : (
              <Pressable
                onPress={() => void (mode === 'todo' ? taskModel.save() : eventModel.save())}
                style={busy ? styles.busy : undefined}
                testID="event-save"
              >
                <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.save}>
                  Save
                </Text>
              </Pressable>
            )}
          </View>

          {sourceKind === 'new' ? (
            <QuickAddBar
              fallbackDate={seed.initialDate.toString()}
              onApply={(item) => void apply(item)}
              timeZone={timeZone}
            />
          ) : null}

          {showToggle ? (
            <View style={styles.modeRow}>
              <SegmentedControl
                accessibilityLabel="Kind"
                grow
                onChange={(next) => void switchTo(next)}
                options={available.map((option) => ({
                  disabled: option !== 'event' && seriesOnly,
                  label: KIND_LABELS[option],
                  testID: `mode-${option}`,
                  value: option,
                }))}
                value={kind}
              />
            </View>
          ) : null}
        </SafeAreaView>
        {birthday ? (
          <BirthdayDetail occurrence={birthday} timeZone={timeZone} />
        ) : mode === 'todo' ? (
          // The selected list's provider picks the form: a Reminders list
          // exposes time/priority/alert/repeat/URL; a Google list gets the
          // plain title/date/notes form. The kind control moves between the
          // providers; the list picker stays within one.
          taskModel.provider === 'apple' ? (
            <ReminderEditForm autoFocusTitle={!quickAdd} task={task} taskModel={taskModel} />
          ) : (
            <TaskEditForm autoFocusTitle={!quickAdd} task={task} taskModel={taskModel} />
          )
        ) : (
          <EventEditForm autoFocusTitle={!quickAdd} model={eventModel} />
        )}
      </View>
    </Modal>
  );
}
