import {
  type EditorConfirmRequest,
  type EditorSeed,
  type EditorSourceKind,
  editorTitle,
  useMarkLesson,
  useModelAvailability,
  useQuickAddModel,
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
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Keyboard,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { onAppActive } from '../appActive.ts';
import { appleSpeech } from '../appleSpeech.ts';
import { backendClient } from '../backend.ts';
import type { LanguageModel, ModelStatus } from '@calendar/ai';
import { type AssistantModelState, statusOf } from '../assistantDownload.ts';
import { assistantDownload, assistantReader, useAssistantModelState } from '../assistantRuntime.ts';
import { languageModel } from '../model.ts';
import { AssistantBar } from './assistant/AssistantBar.tsx';
import { AssistantModelNotice } from './assistant/AssistantModelNotice.tsx';
import { AssistantView } from './assistant/AssistantView.tsx';
import { DraftPager } from './assistant/DraftPager.tsx';
import { PILLS_SHOWN, pillTuckAfter } from './assistant/pillTuck.ts';
import { StepPill } from './assistant/StepPill.tsx';
import { TuckAway } from './assistant/TuckAway.tsx';
import { useKeyboardInset } from './assistant/useKeyboardInset.ts';
import { UseStepCard } from './assistant/UseStepCard.tsx';
import { ViewPill } from './assistant/ViewPill.tsx';
import { BirthdayDetail } from './BirthdayDetail.tsx';
import { useSheetStyles } from './editSheetShared.ts';
import { EventEditForm } from './EventEditForm.tsx';
import { FieldFlashContext, FlashView } from './FlashView.tsx';
import { Row, Section } from './GroupedList.tsx';
import { LessonBanner } from './lesson/LessonBanner.tsx';
import { ModelAvailabilityNotice } from './ModelAvailabilityNotice.tsx';
import { ReminderEditForm } from './ReminderEditForm.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';
import { TaskCheck } from './TaskCheck.tsx';
import { TaskEditForm } from './TaskEditForm.tsx';
import { BOX_FONT_SCALE, groupedGround, useTheme } from './theme.ts';

/** An existing item, a prefilled slot, or a thread of drafts (a capture's events). */
export type EditSeed = EditorSeed;

/** The editor's two views of one draft: the conversation, and the fields. */
export type EditorView = 'assistant' | 'form';

/** How far above the sheet's bottom edge the form's pills float, over the home indicator. */
const PILL_GAP = 10;
/** A pill's height, and the gap to the "Use this" card above it. */
const PILL_HEIGHT = 44;

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

type Editor = ReturnType<typeof useThreadEditor>;

/** The editor is writing: its own save or delete, or a batch. */
const isBusy = ({ eventModel, kinds, taskModel, write }: Editor): boolean =>
  (kinds.mode === 'todo' ? taskModel.busy : eventModel.busy) || write.busy;

/**
 * The Create lesson, around an editor: the first phrase taken, or a
 * save, ticks it as done; the editor going away without either (Cancel,
 * Skip, a swipe down) ticks it as skipped. Once tried, the banner keeps
 * its hint over the draft but loses Skip, which closes the editor — with
 * the draft in it.
 */
const useLessonTry = (lesson: EditSeed['lesson']) => {
  const markLesson = useMarkLesson();
  const tried = useRef(false);
  const [open, setOpen] = useState(lesson !== undefined);
  const done = () => {
    if (lesson && !tried.current) {
      tried.current = true;
      setOpen(false);
      void markLesson(lesson, 'done');
    }
  };
  const leave = useEffectEvent(() => {
    if (lesson && !tried.current) {
      void markLesson(lesson, 'skipped');
    }
  });
  useEffect(() => () => leave(), []);
  return { done, open };
};

/** The header that stays put: Cancel · title · Save, the two as capsules a thumb finds. */
function EditorHeader({
  birthday,
  editor,
  onClose,
  title,
}: {
  readonly birthday: boolean;
  readonly editor: Editor;
  readonly onClose: () => void;
  readonly title: string;
}) {
  const styles = useSheetStyles();
  const { eventModel, kinds, previewing, taskModel, write } = editor;
  const busy = isBusy(editor);
  const nothingToSave =
    birthday ||
    (kinds.mode === 'todo' && taskModel.readOnly) ||
    (kinds.mode === 'event' && eventModel.readOnly);
  // An older step on show is kept or left before anything is written.
  const saveOff = write.busy || previewing;
  return (
    <View style={styles.editorHeader}>
      <View style={styles.capsuleSide}>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.capsule}>
          {/* A birthday's reminder chips save as they change: nothing to cancel. */}
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.capsuleLabel}>
            {birthday ? 'Done' : 'Cancel'}
          </Text>
        </Pressable>
      </View>
      <Text maxFontSizeMultiplier={BOX_FONT_SCALE} numberOfLines={1} style={styles.title}>
        {title}
      </Text>
      <View style={styles.capsuleSide}>
        {nothingToSave ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: saveOff }}
            disabled={saveOff}
            onPress={() => void (kinds.mode === 'todo' ? taskModel.save() : eventModel.save())}
            style={[styles.capsule, styles.capsulePrimary, (busy || previewing) && styles.busy]}
            testID="event-save"
          >
            <Text
              maxFontSizeMultiplier={BOX_FONT_SCALE}
              style={[styles.capsuleLabel, styles.capsulePrimaryLabel]}
            >
              Save
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/**
 * Event | Task | Reminder, only the kinds something can hold, at the
 * form's top: a choice made once, so it scrolls with the form. Left out
 * for a birthday, a read-only item and where there is one kind.
 */
function KindControl({
  birthday,
  editor,
  sourceKind,
}: {
  readonly birthday: boolean;
  readonly editor: Editor;
  readonly sourceKind: EditorSourceKind;
}) {
  const styles = useSheetStyles();
  const { eventModel, kinds, marks, previewing, taskModel } = editor;
  const { available, convertBlocked, kind, switchTo } = kinds;
  const busy = isBusy(editor);
  const show =
    !birthday &&
    available.length > 1 &&
    !(sourceKind === 'event' && eventModel.readOnly) &&
    !(sourceKind === 'task' && taskModel.readOnly);
  if (!show) {
    return null;
  }
  return (
    <View style={styles.topControl}>
      {/* A step that made the item the other kind: the control stays marked. */}
      <FlashView
        bleedX={4}
        bleedY={4}
        flash={marks?.fields.has('kind') ? marks.key : null}
        lasting
        style={styles.modeFlash}
      >
        <SegmentedControl
          accessibilityLabel="Kind"
          ground
          grow
          onChange={(next) => void switchTo(next)}
          options={available.map((option) => ({
            disabled: busy || previewing || (option !== 'event' && convertBlocked),
            label: KIND_LABELS[option],
            testID: `mode-${option}`,
            value: option,
          }))}
          value={kind}
        />
      </FlashView>
    </View>
  );
}

/**
 * The fields: a to-do's completion row, then the form its kind and
 * provider pick — a Reminders list exposes time, priority, alert, repeat
 * and URL; a Google list gets the plain title, date and notes; the kind
 * control moves between the providers, the list picker stays within one.
 * The fields the step on show changed stay marked (`FieldFlash` in the
 * forms). A new item's title does not take the focus: the keyboard would
 * cover the form the Assistant, or a tap, just brought up.
 */
function EditorForm({
  bare,
  birthday,
  editor,
  sourceKind,
  task,
  timeZone,
}: {
  readonly bare: boolean;
  readonly birthday: BirthdayOccurrence | undefined;
  readonly editor: Editor;
  readonly sourceKind: EditorSourceKind;
  readonly task: TaskRecord | undefined;
  readonly timeZone: string;
}) {
  const { eventModel, kinds, marks, taskModel } = editor;
  const busy = isBusy(editor);
  const done = task?.status === 'completed';
  const completionTitle = done ? 'Mark as Incomplete' : 'Mark as Done';
  const { toggleCompletion } = taskModel;
  const confirmDiscard = () =>
    new Promise<boolean>((resolve) => {
      Alert.alert('Discard unsaved edits?', 'Changing completion closes this editor.', [
        { onPress: () => resolve(false), style: 'cancel', text: 'Keep Editing' },
        { onPress: () => resolve(true), style: 'destructive', text: completionTitle },
      ]);
    });
  const autoFocusTitle = sourceKind !== 'new';
  const fields = birthday ? (
    <BirthdayDetail occurrence={birthday} timeZone={timeZone} />
  ) : kinds.mode !== 'todo' ? (
    <EventEditForm autoFocusTitle={autoFocusTitle} bare={bare} model={eventModel} />
  ) : taskModel.provider === 'apple' ? (
    <ReminderEditForm
      autoFocusTitle={autoFocusTitle}
      bare={bare}
      task={task}
      taskModel={taskModel}
    />
  ) : (
    <TaskEditForm autoFocusTitle={autoFocusTitle} bare={bare} task={task} taskModel={taskModel} />
  );
  return (
    <FieldFlashContext value={marks}>
      {kinds.mode === 'todo' && toggleCompletion ? (
        <Section tight>
          <Row
            accessibilityLabel="Completed"
            accessibilityRole="checkbox"
            accessibilityState={{ checked: done }}
            disabled={busy}
            leading={<TaskCheck checked={done} size="list" />}
            // Anything not saved yet is asked about: an edit by hand, and a
            // step of the thread (a phrase to the Assistant changes the
            // to-do without touching a field).
            onPress={() =>
              void toggleCompletion(
                editor.userEdits > 0 || editor.steps.of > 0 ? confirmDiscard : undefined,
              )
            }
            testID="task-editor-completion"
            title={completionTitle}
          />
        </Section>
      ) : null}
      {fields}
    </FieldFlashContext>
  );
}

/** Whether VoiceOver is on: what hides on a gesture stays put for it. */
const useScreenReader = (): boolean => {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let gone = false;
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (!gone) {
        setOn(enabled);
      }
    });
    const changed = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => {
      gone = true;
      changed.remove();
    };
  }, []);
  return on;
};

/**
 * The form as the route's view: the fields scrolling, and over their
 * bottom edge, by the thumb, the steps on the left, the way back to the
 * Assistant on the right and, above them, an older step on show with
 * "Use this". They get out of the way while the form is scrolled down
 * and come back on a scroll up (`pillTuck.ts`), so what a scroll just
 * brought up is in reach at once — a chip under the Assistant pill used
 * to take the tap meant for it; not while an older step is on show
 * (its "Use this" is the way on) and not under VoiceOver. Nothing floats
 * while the keyboard is up: there is no room for it over the field being
 * typed into.
 */
function FormView({
  assists,
  banner,
  children,
  editor,
  listening,
  onAssistant,
}: {
  readonly assists: boolean;
  /** Above the fields: the lesson's frame (without the model, the form is where the lesson opens). */
  readonly banner: ReactNode;
  readonly children: ReactNode;
  readonly editor: Editor;
  /** Dictation is still listening behind the form. */
  readonly listening: boolean;
  readonly onAssistant: () => void;
}) {
  const styles = useSheetStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset();
  const screenReader = useScreenReader();
  const { previewing, steps } = editor;
  const pillBottom = insets.bottom + PILL_GAP;
  const ground = groupedGround(colors);
  const floating = keyboard === 0 && (assists || steps.of > 0);
  // Where the scroll stands against its last turn is a ref: only a flip renders.
  const tuck = useRef(PILLS_SHOWN);
  const [tucked, setTucked] = useState(false);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    tuck.current = pillTuckAfter(
      tuck.current,
      contentOffset.y,
      contentSize.height - layoutMeasurement.height,
    );
    setTucked(tuck.current.tucked);
  };
  return (
    <View style={styles.route}>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={floating ? styles.floatingRoom : undefined}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {banner}
        {/* An older step on show is looked at, not edited. */}
        <View pointerEvents={previewing ? 'none' : 'auto'}>{children}</View>
      </ScrollView>
      {floating ? (
        <TuckAway tucked={tucked && !previewing && !screenReader}>
          {/* The rows under the pills recede into the ground, so the pills read. */}
          <View
            pointerEvents="none"
            style={[
              styles.pillFade,
              {
                backgroundImage: `linear-gradient(to bottom, ${ground}00, ${ground} 62%)`,
                height: pillBottom + PILL_HEIGHT + (previewing ? 124 : 44),
              },
            ]}
          />
          {previewing ? (
            <UseStepCard bottom={pillBottom + PILL_HEIGHT + 12} editor={editor} />
          ) : null}
          <StepPill bottom={pillBottom} steps={steps} />
          {assists ? (
            <ViewPill bottom={pillBottom} listening={listening} onPress={onAssistant} />
          ) : null}
        </TuckAway>
      ) : null}
    </View>
  );
}

/**
 * The shell for creating and editing events, tasks and reminders: a
 * header that stays put (Cancel · title · Save, as capsules), then one
 * of two views of the same draft, as on the desktop (`useThreadEditor`).
 *
 * Assistant is a conversation (`AssistantView`): a phrase, spoken or
 * typed, makes the draft(s) or changes them; each answer is the item as
 * a card with what changed marked, and what the assistant has to ask (a
 * place, a contact, a free slot) sits under the newest card. Its bar is
 * at the bottom by the thumb: Type · the microphone · Form. Form is the
 * fields, and needs no model: the Event | Task | Reminder control (only
 * the kinds something can hold) and the grouped cards of EventEditForm /
 * TaskEditForm / ReminderEditForm, with the way back to the Assistant
 * and the steps floating over its bottom edge, out of the way while the
 * form is scrolled down. One view is mounted at a
 * time; the draft is the thread's, so nothing is lost in a flip, and
 * dictation goes on behind the form until a field is edited by hand.
 *
 * The calendar's "+", a share and the Create lesson open on the
 * Assistant — unless the model turns out not to be ready before anything
 * was said, when the editor falls back to the Form once; a slot drawn on
 * the grid, a to-do's "+" and a saved item open on the Form. A read-only
 * item, a birthday and an editor opened to convert have the Form alone.
 *
 * A phrase, an edit by hand and a picked choice are the thread's steps.
 * The pill steps back and forward through them; an older step on show is
 * looked at, not edited — the form does not take touches, Save is off —
 * until "Use this" keeps it (and lets the later steps go) or the newest
 * is shown again. The fields the step on show changed stay marked. With
 * several drafts (a share) the pager, Remove and "Add all" sit under the
 * header in either view; Save on one of several writes it and moves to
 * the next.
 */

/** A model that is never asked: the Assistant's own runs, and Apple's is not checked for it. */
const NO_CHECK: LanguageModel = {
  generateJson: async () => {
    throw new Error('Not asked: the Assistant runs on its own model.');
  },
  status: async () => 'ready',
};

/** The Create lesson's note while the Assistant's model is not on this iPhone yet. */
const lessonNoteOf = (state: AssistantModelState): string => {
  switch (state.kind) {
    case 'unsupported':
      return 'This iPhone cannot run the Assistant’s model — the form still makes an event.';
    case 'unasked':
    case 'declined':
      return 'Describing an event needs the Assistant’s model, a one-time download — the form still makes one.';
    case 'failed':
      return 'The Assistant’s model did not download — Try Again in the Assistant; the form still makes an event.';
    default:
      return 'The Assistant’s model is still downloading — the form still makes an event.';
  }
};

export function EventEditSheet({
  birthday,
  calendars,
  initialKind,
  onClose,
  onSaved,
  opensOn = 'form',
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
  /** The view to start on, where there are two. */
  opensOn?: EditorView | undefined;
  /**
   * 'modal': its own page sheet (the birthday detail). 'route': the body
   * of the editor's route (`app/editor.tsx`), which presents it.
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
  const lesson = useLessonTry(seed.lesson);
  const editor = useThreadEditor({
    backend: backendClient,
    calendars,
    confirm: confirmEditorRequest,
    initialKind,
    model: languageModel,
    onClose,
    onSaved: () => {
      lesson.done();
      onSaved?.();
    },
    reader: assistantReader(),
    seed,
    sourceKind,
    task,
    taskLists,
    taskSeed,
    timeZone,
  });
  const { drafts, kinds, onPhrase, previewing, steps } = editor;

  // The two views. Without an Assistant (a read-only item, a birthday, a
  // conversion) there is the form alone.
  const assists = editor.assistant !== 'none' && presentation === 'route';
  const [view, setView] = useState<EditorView>(assists ? opensOn : 'form');
  const shown: EditorView = assists ? view : 'form';
  // The model answers a moment after the editor opened. Not ready, and
  // nothing said or typed yet: the form is what there is to work with,
  // once — the Assistant says why and is a tap away.
  // The Assistant runs on its own model (`assistantRuntime.ts`), whose state
  // is known at once; Apple's is asked only under the fixture model (e2e).
  const ownModel = assistantReader() !== undefined;
  const appleAvailability = useModelAvailability(ownModel ? NO_CHECK : languageModel, onAppActive);
  const own = useAssistantModelState();
  const status: ModelStatus | null = ownModel ? statusOf(own) : appleAvailability.status;
  const answered = useRef(false);
  useEffect(() => {
    if (status === null || answered.current) {
      return;
    }
    answered.current = true;
    if (status !== 'ready' && steps.of === 0) {
      setView('form');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the first answer only
  }, [status]);
  const download = assistantDownload();
  const notice =
    status === null || status === 'ready' ? undefined : ownModel ? (
      <AssistantModelNotice
        network={download.network()}
        onAction={(action) => {
          if (action === 'download') {
            void download.agree('wifi');
          } else if (action === 'mobile') {
            void download.allowMobileData();
          } else {
            void download.retry();
          }
        }}
        size={download.size()}
        state={own}
      />
    ) : appleAvailability.availability ? (
      <ModelAvailabilityNotice
        availability={appleAvailability.availability}
        checkedAt={appleAvailability.checkedAt}
        lastManualCheck={appleAvailability.lastManualCheck}
        manualChecking={appleAvailability.manualChecking}
        onCheckAgain={appleAvailability.retry}
      />
    ) : undefined;

  // The Create lesson's frame, over either view. Where the model is not
  // ready the editor has fallen back to its form: the banner says why the
  // lesson is not as drawn.
  const lessonBanner = seed.lesson ? (
    <LessonBanner
      id={seed.lesson}
      note={
        status === null || status === 'ready'
          ? undefined
          : ownModel
            ? lessonNoteOf(own)
            : 'Describing an event needs Apple Intelligence, which is not ready on this iPhone — the form still makes one.'
      }
      onSkip={lesson.open ? onClose : undefined}
    />
  ) : null;

  // What is said or typed to the Assistant. Here, above both views, so a
  // flip to the form neither drops the words nor ends the listening: an
  // edit by hand there does (`editKey`).
  const quick = useQuickAddModel({
    editKey: editor.userEdits,
    fallbackDate: seed.initialDate.toString(),
    hold: editor.applying,
    initialText: seed.quickAddText,
    model: languageModel,
    // An older step on show: nothing is listened for, and listening ends.
    off: previewing,
    onApply: (item) => {
      lesson.done();
      void kinds.apply(item);
    },
    onPhrase: async (text) => {
      const message = await onPhrase(text);
      if (message === undefined) {
        lesson.done();
        // Taken: the keyboard goes, so the answer is what shows.
        Keyboard.dismiss();
      }
      return message;
    },
    speech: appleSpeech,
    timeZone,
  });

  const { noun, verb } = editorTitle({
    kind: kinds.kind,
    sourceKind,
    sourceProvider: task?.provider,
  });
  const header = (
    <EditorHeader
      birthday={birthday !== undefined}
      editor={editor}
      onClose={onClose}
      title={birthday ? 'Birthday' : `${verb} ${capitalize(noun)}`}
    />
  );
  const kindControl = (
    <KindControl birthday={birthday !== undefined} editor={editor} sourceKind={sourceKind} />
  );
  const saveError = kinds.mode === 'todo' ? editor.taskModel.error : editor.eventModel.error;
  const form = (
    <EditorForm
      bare={presentation === 'route'}
      birthday={birthday}
      editor={editor}
      sourceKind={sourceKind}
      task={task}
      timeZone={timeZone}
    />
  );

  // The editor's route (`app/editor.tsx`), a page sheet at full height.
  if (presentation === 'route') {
    return (
      <View style={styles.route} testID={`editor-${shown}`}>
        <View style={styles.sheetHeader}>{header}</View>
        <DraftPager editor={editor} />
        {shown === 'assistant' ? (
          <>
            <AssistantView
              banner={lessonBanner}
              calendars={calendars}
              editor={editor}
              note={seed.thread?.note}
              notice={notice}
              onEdit={() => setView('form')}
              pending={quick.busy && quick.phrase.trim() !== '' ? quick.phrase : undefined}
              taskLists={taskLists}
            />
            {previewing ? <UseStepCard editor={editor} /> : null}
            {/* Why Save did nothing: the form shows it among its rows, and is not on screen here. */}
            {saveError ? (
              <Text
                accessibilityLiveRegion="assertive"
                accessibilityRole="alert"
                selectable
                style={styles.formError}
                testID="editor-error"
              >
                {saveError}
              </Text>
            ) : null}
            <AssistantBar
              hasDrafts={drafts.length > 0}
              onForm={() => setView('form')}
              previewing={previewing}
              quick={quick}
              startTyping={seed.quickAddText !== undefined}
              status={status}
            />
          </>
        ) : (
          <FormView
            assists={assists}
            banner={lessonBanner}
            editor={editor}
            listening={quick.handsFree}
            onAssistant={() => setView('assistant')}
          >
            {kindControl}
            {form}
          </FormView>
        )}
      </View>
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
          {header}
          {kindControl}
        </SafeAreaView>
        {form}
      </View>
    </Modal>
  );
}
