import {
  type EditorConfirmRequest,
  type EditorSeed,
  type EditorSourceKind,
  editorTitle,
  useThreadEditor,
  type TaskEditorSeed,
} from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  type CalendarInfo,
  type ItemKind,
  type TaskListInfo,
  type TaskRecord,
} from '@calendar/core';
import { Alert, Modal, Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { backendClient } from '../backend.ts';
import { languageModel } from '../model.ts';
import { BirthdayDetail } from './BirthdayDetail.tsx';
import { DraftThreadSection } from './DraftThreadSection.tsx';
import { useSheetStyles } from './editSheetShared.ts';
import { EventEditForm } from './EventEditForm.tsx';
import { FieldFlashContext, FlashView } from './FlashView.tsx';
import { QuickAddBar } from './QuickAddBar.tsx';
import { ReminderEditForm } from './ReminderEditForm.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';
import { TaskEditForm } from './TaskEditForm.tsx';
import { BOX_FONT_SCALE } from './theme.ts';

/** An existing item, a prefilled slot, or a thread of drafts (a capture's events). */
export type EditSeed = EditorSeed;

const CHANGE_PLACEHOLDER = 'Change it: “at 8”, “Thursday instead”…';

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
 * item the quick-add field sits on top, then the thread (the turns with
 * Undo, the free slots, the pager and "Add all"), then the Event | Task |
 * Reminder control (only the kinds something can hold), then the form. A
 * new item is a thread of drafts, as on the desktop (`useThreadEditor`):
 * the first phrase makes the draft(s), every later phrase in the same
 * field changes them, and Save on one of several writes it and moves to
 * the next. The forms live in EventEditForm / TaskEditForm /
 * ReminderEditForm; this file owns the header and the thread editor (both
 * models stay mounted, so state survives a kind flip).
 */
export function EventEditSheet({
  birthday,
  calendars,
  initialKind,
  onClose,
  onSaved,
  presentation = 'modal',
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
  /**
   * 'modal': its own page sheet (the birthday detail). 'route': the body
   * of the editor's form-sheet route (`app/editor.tsx`), which presents it.
   */
  presentation?: 'modal' | 'route' | undefined;
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
  const editor = useThreadEditor({
    backend: backendClient,
    calendars,
    confirm: confirmEditorRequest,
    initialKind,
    model: languageModel,
    onClose,
    onSaved,
    seed,
    sourceKind,
    task,
    taskLists,
    taskSeed,
    timeZone,
  });
  const { drafts, eventModel, flash, kinds, onPhrase, taskModel, write } = editor;
  const { apply, available, kind, mode, seriesOnly, switchTo } = kinds;

  const showToggle =
    !birthday &&
    available.length > 1 &&
    !(sourceKind === 'event' && eventModel.readOnly) &&
    !(sourceKind === 'task' && taskModel.readOnly);
  const busy = (mode === 'todo' ? taskModel.busy : eventModel.busy) || write.busy;
  // A new item: the quick-add field on top takes the focus, not the title.
  const quickAdd = sourceKind === 'new';
  const { noun, verb } = editorTitle({ kind, sourceKind, sourceProvider: task?.provider });
  const title = birthday ? 'Birthday' : `${verb} ${capitalize(noun)}`;

  // The header: the Cancel · title · Save row, then for a new item the
  // quick-add field and the thread, then the kind control.
  const headerRow = (
    <View style={[styles.header, styles.headerCompact]}>
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
          disabled={write.busy}
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
  );
  const headerRest = (
    <>
      {sourceKind === 'new' ? (
        <>
          <QuickAddBar
            autoFocus={presentation !== 'route'}
            fallbackDate={seed.initialDate.toString()}
            onApply={(item) => void apply(item)}
            onPhrase={onPhrase}
            placeholder={drafts.length > 0 ? CHANGE_PLACEHOLDER : undefined}
            timeZone={timeZone}
          />
          <DraftThreadSection editor={editor} note={seed.thread?.note} />
        </>
      ) : null}

      {showToggle ? (
        <View style={styles.modeRow}>
          {/* A turn that made the item the other kind: the control tints and fades back. */}
          <FlashView
            bleedX={4}
            bleedY={4}
            flash={flash?.fields.has('kind') ? flash.key : null}
            style={styles.modeFlash}
          >
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
          </FlashView>
        </View>
      ) : null}
    </>
  );
  const bare = presentation === 'route';
  // The fields the last turn changed flash (`FieldFlash` in the forms).
  const form = (
    <FieldFlashContext value={flash}>
      {birthday ? (
        <BirthdayDetail occurrence={birthday} timeZone={timeZone} />
      ) : mode === 'todo' ? (
        // The selected list's provider picks the form: a Reminders list
        // exposes time/priority/alert/repeat/URL; a Google list gets the
        // plain title/date/notes form. The kind control moves between the
        // providers; the list picker stays within one.
        taskModel.provider === 'apple' ? (
          <ReminderEditForm
            autoFocusTitle={!quickAdd}
            bare={bare}
            task={task}
            taskModel={taskModel}
          />
        ) : (
          <TaskEditForm autoFocusTitle={!quickAdd} bare={bare} task={task} taskModel={taskModel} />
        )
      ) : (
        <EventEditForm autoFocusTitle={!quickAdd} bare={bare} model={eventModel} />
      )}
    </FieldFlashContext>
  );
  // The form-sheet route (`app/editor.tsx`): react-native-screens lays a
  // sheet out once, as at most a header and a scroll view — the header must
  // not be flattened away (`collapsable={false}`), the scroll view follows
  // it directly, and it stays the same view across a kind switch (the
  // forms render bare inside it): anything wrapped around them, or a
  // scroll view swapped in later, it places over the header.
  if (presentation === 'route') {
    return (
      <>
        <View collapsable={false} style={styles.sheetHeader}>
          {headerRow}
          {headerRest}
        </View>
        <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
          {form}
        </ScrollView>
      </>
    );
  }
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
          {headerRow}
          {headerRest}
        </SafeAreaView>
        {form}
      </View>
    </Modal>
  );
}
