import { type CaptureSource, tunedReader } from '@calendar/ai';
import {
  CONVERT_SCOPE_HINT,
  type EditorSeed,
  type EditorSourceKind,
  type EditorView,
  editorTitle,
  stepName,
  stepSource,
  useMarkLesson,
  useMoveConfirmation,
  useThreadEditor,
  type TaskEditorSeed,
} from '@calendar/app-state';
import {
  type CalendarInfo,
  type ItemKind,
  type TaskListInfo,
  type TaskRecord,
} from '@calendar/core';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  assistantStatusOf,
  desktopAssistantModel,
  useAssistantModelState,
  useFinder,
} from '../../ai/assistantModel.ts';
import { backend } from '../../backend.ts';
import { LessonBanner } from '../../onboarding/LessonBanner.tsx';
import { Button } from '../../ui/Button.tsx';
import { IconButton } from '../../ui/IconButton.tsx';
import { RedoIcon, UndoIcon, VideoIcon, XIcon } from '../../ui/icons.tsx';
import { SegmentedControl } from '../../ui/SegmentedControl.tsx';
import { AssistantView } from '../assistant/AssistantView.tsx';
import { EventEditorForm } from '../EventEditorForm.tsx';
import { MoveConfirm } from '../MoveConfirm.tsx';
import { DraftPager } from './DraftPager.tsx';
import { useViewSwitch } from './useViewSwitch.ts';
import { ReminderEditorForm } from '../ReminderEditorForm.tsx';
import { TaskEditorForm } from '../TaskEditorForm.tsx';
import { FieldFlashContext, useFlash } from '../../ui/useFlash.ts';

/** The Assistant reads phrases with its own model (electron/assistantModel/), as on the iPhone. */
const assistantReader = tunedReader(desktopAssistantModel);

const KIND_LABELS: Record<ItemKind, string> = {
  event: 'Event',
  reminder: 'Reminder',
  task: 'Task',
};

export type { EditorView } from '@calendar/app-state';

/**
 * The side panel's editor: a header that stays put (the title, the two
 * views' tabs, Join meeting, Close), one of two views of the same draft,
 * and a footer that stays put with the steps, Delete, Cancel and Save,
 * so the way out and the save are in reach from either view. A question
 * before a lossy switch, move, conversion or delete sits above the
 * footer's buttons, on screen whatever is scrolled.
 *
 * Assistant is a conversation (`AssistantView`): a phrase, typed or
 * dictated, makes the draft(s) or changes them, each answer is the item
 * as a card with what changed marked, and what the assistant has to ask
 * (a place, a contact, a free slot) sits under the newest card. With
 * several drafts (a paste) the pager, Remove and "Add all" sit under the
 * header in either view (`DraftPager`). Form is
 * the fields, and needs no model: the Event | Task | Reminder control
 * (only the kinds something can hold), then the form — in create mode
 * the control picks the kind; on an existing item it converts (Save
 * writes the other kind and deletes the source) or moves a to-do to the
 * other provider. Both stay mounted, so a flip keeps state and the form
 * always holds the draft. A new item opened by "+ New", ⌘N or ⌘K starts
 * on the Assistant — unless the model turns out not to be ready before
 * anything was said, when it falls back to the Form once; one opened
 * from a slot picked on the grid, and a saved item, start on the Form.
 * A read-only item, a birthday and an editor opened to convert have no
 * Assistant and no tabs.
 *
 * Both views are one thread (`useThreadEditor`, shared with the iOS edit
 * sheet): a phrase, an edit made by hand and a picked choice are its
 * steps, and the calendar draws every draft hatched, the focused one
 * outlined and scrolled to (the draft atoms). The footer steps back and
 * forward through them; an older step on show is looked at, not edited —
 * the form is locked, Save is off — until "Use this" keeps it (and lets
 * the later steps go) or the newest is shown again. The fields the step
 * on show changed stay marked in the form. Save writes the focused
 * draft; with several, "Add all" writes the rest as they are and the
 * focused one through the form. The e2e suite relies on the title text
 * ("New event", "Edit reminder", …), the Delete/Cancel/Save labels, the
 * mode and view test ids and the `draft-*`, `assistant-*`, `step-*` and
 * `quick-add-*` test ids.
 */
export function EditorPanel({
  calendars,
  initialKind,
  onCapture,
  onClose,
  onSaved,
  opensOn = 'form',
  quickAddFocus = 0,
  seed,
  task,
  taskLists,
  taskSeed,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  /** The kind to open on: a to-do for a "+" that wants one, or Convert from the inspector. */
  initialKind?: ItemKind | undefined;
  /** A paste into the assistant's field that is an email or an image goes to capture. */
  onCapture: (source: CaptureSource) => void;
  onClose: () => void;
  /** Save went through, as an event or a task. */
  onSaved?: (() => void) | undefined;
  /** The view to start on, where there are two: the Assistant for "+ New", ⌘N, ⌘K and a capture. */
  opensOn?: EditorView | undefined;
  /** ⌘K: bumped to bring the Assistant forward and focus its field. */
  quickAddFocus?: number | undefined;
  seed: EditorSeed;
  /** Present when the editor was opened from a task chip (task edit mode). */
  task?: TaskRecord | undefined;
  taskLists: ReadonlyArray<TaskListInfo>;
  /** A new to-do's start: undated (an inbox add) and the list to open in. */
  taskSeed?: Pick<TaskEditorSeed, 'dated' | 'listKey'> | undefined;
  timeZone: string;
}) {
  const sourceKind: EditorSourceKind = task ? 'task' : seed.event ? 'event' : 'new';
  const moveConfirmation = useMoveConfirmation();
  // The Create lesson: the first phrase taken, or a save, ticks it as
  // done; the editor going away without either (Cancel, Skip, Escape,
  // another item opened in the panel) ticks it as skipped.
  const lesson = seed.lesson;
  const markLesson = useMarkLesson();
  const lessonTried = useRef(false);
  // Once tried, the banner keeps its hint over the draft but loses Skip,
  // which closes the editor — with the draft in it.
  const [lessonOpen, setLessonOpen] = useState(lesson !== undefined);
  const lessonDone = () => {
    if (lesson && !lessonTried.current) {
      lessonTried.current = true;
      setLessonOpen(false);
      void markLesson(lesson, 'done');
    }
  };
  const leaveLesson = useEffectEvent(() => {
    if (lesson && !lessonTried.current) {
      void markLesson(lesson, 'skipped');
    }
  });
  useEffect(() => () => leaveLesson(), []);
  const { finder } = useFinder();
  const editor = useThreadEditor({
    backend,
    calendars,
    confirm: moveConfirmation.request,
    finder,
    initialKind,
    onClose,
    onSaved: () => {
      lessonDone();
      onSaved?.();
    },
    reader: assistantReader,
    seed,
    sourceKind,
    task,
    taskLists,
    taskSeed,
    timeZone,
  });
  const { eventModel, kinds, marks, onPhrase, previewing, steps, taskModel, userEdits } = editor;
  const { joinUrl } = eventModel;
  const { available, convertBlocked, kind, mode, switchTo } = kinds;
  // A step that made the item the other kind: the control stays marked.
  const kindMark = useFlash<HTMLDivElement>(marks?.fields.has('kind') ? marks.key : null, true);

  // The two views. Without an Assistant (a read-only item, a conversion)
  // there is the form alone, and no tabs.
  const assists = editor.assistant !== 'none';
  // The form rises out of the newest card and folds back into it (`useViewSwitch`).
  const switcher = useViewSwitch(assists ? opensOn : 'form');
  const shown: EditorView = assists ? switcher.view : 'form';
  // The pane leaving while the switch runs: still drawn, under the one
  // coming in, out of reach.
  const leaving = switcher.flight?.from;
  const arriving = leaving ? 'relative z-10' : '';
  // The model answers a moment after the editor opened. Not ready, and
  // nothing said or typed yet: the form is what there is to work with,
  // once — the Assistant says why and is a tab away.
  const modelState = useAssistantModelState();
  const availability = { state: modelState, status: assistantStatusOf(modelState) };
  const answered = useRef(false);
  useEffect(() => {
    if (availability.status === null || answered.current) {
      return;
    }
    answered.current = true;
    if (availability.status !== 'ready' && steps.of === 0) {
      switcher.snap('form');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the first answer only
  }, [availability.status]);
  // The Create lesson's frame, over either view. Where the model is not
  // ready the editor has fallen back to its form: the banner says why the
  // lesson is not as drawn.
  const lessonBanner = lesson ? (
    <LessonBanner
      id={lesson}
      note={
        availability.status !== null && availability.status !== 'ready'
          ? 'Describing an event needs the Assistant’s model, which is not on this Mac yet — the form still makes one.'
          : undefined
      }
      onSkip={lessonOpen ? onClose : undefined}
    />
  ) : null;
  // ⌘K is for the Assistant's field: a press since this editor opened
  // brings the view forward (the count is the window's, and outlives an
  // editor).
  const focusAtOpen = useRef(quickAddFocus);
  const toAssistant = useEffectEvent(() => switcher.flip('assistant'));
  useEffect(() => {
    if (quickAddFocus !== focusAtOpen.current) {
      toAssistant();
    }
  }, [quickAddFocus]);

  const showToggle =
    available.length > 1 &&
    !(sourceKind === 'event' && eventModel.readOnly) &&
    !(sourceKind === 'task' && taskModel.readOnly);
  const { noun, verb } = editorTitle({ kind, sourceKind, sourceProvider: task?.provider });
  const title = `${verb} ${noun}`;

  return (
    <div
      aria-label={mode === 'todo' ? 'Task editor' : 'Event editor'}
      className="flex min-h-0 flex-1 flex-col"
      data-switching={switcher.flight ? '' : undefined}
      data-testid="editor"
      data-view={shown}
    >
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold" data-testid="editor-title">
          {title}
        </h2>
        {assists ? (
          <SegmentedControl
            label="View"
            onChange={switcher.flip}
            options={[
              { label: 'Assistant', testId: 'editor-view-assistant', value: 'assistant' },
              { label: 'Form', testId: 'editor-view-form', value: 'form' },
            ]}
            size="sm"
            value={shown}
          />
        ) : null}
        {joinUrl ? (
          <Button onClick={() => window.open(joinUrl, '_blank', 'noopener')} size="sm">
            <VideoIcon size={14} />
            Join meeting
          </Button>
        ) : null}
        <IconButton data-testid="editor-close" label="Close" onClick={onClose} size="sm">
          <XIcon size={14} />
        </IconButton>
      </div>

      <DraftPager confirming={moveConfirmation.pending !== null} editor={editor} />

      {/* While the switch runs, the form rides inside this frame: never over the footer. */}
      <div
        className={`relative flex min-h-0 flex-1 flex-col ${switcher.flight ? 'overflow-hidden' : ''}`}
        ref={switcher.frame}
      >
        {assists ? (
          <div
            className={
              leaving === 'assistant'
                ? 'absolute inset-0 flex flex-col'
                : shown === 'assistant'
                  ? `${arriving} flex min-h-0 flex-1 flex-col`
                  : 'hidden'
            }
            data-testid="editor-assistant"
            inert={leaving === 'assistant'}
            ref={switcher.assistantPane}
          >
            <AssistantView
              active={shown === 'assistant'}
              availability={availability}
              banner={lessonBanner}
              calendars={calendars}
              editKey={userEdits}
              editor={editor}
              focusSignal={quickAddFocus}
              initialText={seed.quickAddText}
              note={seed.thread?.note}
              onCapture={onCapture}
              onEdit={() => switcher.flip('form')}
              onPhrase={async (text) => {
                const message = await onPhrase(text);
                if (message === undefined) {
                  lessonDone();
                }
                return message;
              }}
              taskLists={taskLists}
              timeZone={timeZone}
            />
          </div>
        ) : null}

        <div
          className={
            leaving === 'form'
              ? 'absolute inset-0 flex flex-col overflow-y-auto px-4 pt-1 pb-4'
              : shown === 'form'
                ? `${arriving} flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-1 pb-4`
                : 'hidden'
          }
          data-testid="editor-form"
          inert={leaving === 'form'}
          ref={switcher.formPane}
        >
          {/* The lesson's frame is over the form too: without the model, the form is where it opens. */}
          {lessonBanner}
          {/* An older step on show is looked at, not edited. */}
          <fieldset className="contents" disabled={previewing}>
            {showToggle ? (
              <SegmentedControl
                className="mb-4 w-full"
                grow
                label="Kind"
                onChange={(option) => void switchTo(option)}
                options={available.map((option) => ({
                  disabled:
                    previewing ||
                    moveConfirmation.pending !== null ||
                    (option !== 'event' && convertBlocked),
                  label: KIND_LABELS[option],
                  testId: `mode-${option}`,
                  title: option !== 'event' && convertBlocked ? CONVERT_SCOPE_HINT : undefined,
                  value: option,
                }))}
                ref={kindMark}
                size="sm"
                value={kind}
              />
            ) : null}

            {/* The fields the step on show changed stay marked (`useFieldFlash`). */}
            <FieldFlashContext value={marks}>
              {mode === 'todo' ? (
                // The selected list's provider picks the form: a Reminders list
                // exposes time/priority/alert/repeat/URL; a Google list gets the
                // plain title/date/notes form. The kind control moves between the
                // providers; the list picker stays within one.
                taskModel.provider === 'apple' ? (
                  <ReminderEditorForm task={task} taskModel={taskModel} />
                ) : (
                  <TaskEditorForm task={task} taskModel={taskModel} />
                )
              ) : (
                <EventEditorForm model={eventModel} />
              )}
            </FieldFlashContext>
          </fieldset>
        </div>
      </div>

      <EditorFooter
        editor={editor}
        moveConfirmation={moveConfirmation}
        onClose={onClose}
        task={task}
        view={shown}
      />
    </div>
  );
}

/**
 * The way through the thread's steps, at the footer's start: one back,
 * where it stands, one forward. Not there before the first step.
 */
function StepControl({ steps }: { steps: ReturnType<typeof useThreadEditor>['steps'] }) {
  if (steps.of === 0) {
    return null;
  }
  return (
    <div className="flex items-center" data-testid="step-control">
      <IconButton
        data-testid="step-back"
        disabled={steps.locked || steps.at === 0}
        label="Step back"
        onClick={steps.back}
        size="sm"
      >
        <UndoIcon size={14} />
      </IconButton>
      <span
        className="min-w-11 text-center text-xs text-ink-secondary tabular-nums"
        data-testid="step-position"
      >
        {steps.at === 0 ? 'Start' : `${String(steps.at)} of ${String(steps.of)}`}
      </span>
      <IconButton
        data-testid="step-forward"
        disabled={steps.locked || steps.at === steps.of}
        label="Step forward"
        onClick={steps.forward}
        size="sm"
      >
        <RedoIcon size={14} />
      </IconButton>
    </div>
  );
}

/**
 * An older step on show: which one it is, in a line, and "Use this" —
 * which keeps it and lets the steps after it go. Stepping forward leaves
 * it instead.
 */
function StepPreview({ editor }: { editor: ReturnType<typeof useThreadEditor> }) {
  const { assistant, steps } = editor;
  const shown = steps.line[steps.at - 1];
  return (
    <div className="flex shrink-0 items-center gap-2 px-4 pt-2" data-testid="step-preview">
      <div className="min-w-0 flex-1 rounded-control bg-fill px-3 py-1.5">
        <p className="text-[11px] font-semibold tracking-wide text-ink-secondary uppercase">
          {shown
            ? `Step ${String(steps.at)} of ${String(steps.of)} · ${stepSource(shown)}`
            : 'The start'}
        </p>
        <p className="truncate text-sm" data-testid="step-name">
          {shown ? stepName(shown) : assistant === 'saved' ? 'As saved' : 'Nothing yet'}
        </p>
      </div>
      <Button
        data-testid="step-use"
        disabled={steps.locked}
        onClick={steps.use}
        size="sm"
        variant="primary"
      >
        Use this
      </Button>
    </div>
  );
}

/**
 * What stays put under the views: an older step on show with "Use this",
 * why a save failed while the Assistant is on show (the form says so
 * itself), the question a lossy switch, move, conversion or delete waits
 * on, then the steps, Delete, Cancel and Save.
 */
function EditorFooter({
  editor,
  moveConfirmation,
  onClose,
  task,
  view,
}: {
  editor: ReturnType<typeof useThreadEditor>;
  moveConfirmation: ReturnType<typeof useMoveConfirmation>;
  onClose: () => void;
  task: TaskRecord | undefined;
  /** The view on show: the form says why a save failed itself, the Assistant has the footer say it. */
  view: EditorView;
}) {
  const { eventModel, kinds, previewing, steps, taskModel, write } = editor;
  // The footer's actions act on the form that is showing.
  const current =
    kinds.mode === 'todo'
      ? {
          busy: taskModel.busy,
          canDelete: Boolean(task) && !taskModel.readOnly,
          error: taskModel.error,
          readOnly: taskModel.readOnly,
          remove: taskModel.remove,
          save: taskModel.save,
        }
      : {
          busy: eventModel.busy,
          canDelete: Boolean(eventModel.existing) && !eventModel.readOnly,
          error: eventModel.error,
          readOnly: eventModel.readOnly,
          remove: eventModel.remove,
          save: eventModel.save,
        };
  return (
    <>
      {previewing ? <StepPreview editor={editor} /> : null}
      {/* Why Save did nothing: the form shows it among its fields, which the Assistant covers. */}
      {view === 'assistant' && current.error ? (
        <p
          className="mx-4 mt-2 shrink-0 select-text rounded-control bg-fill p-2 text-sm text-danger"
          data-testid="editor-error"
          role="alert"
        >
          {current.error}
        </p>
      ) : null}
      {moveConfirmation.pending ? (
        <div className="shrink-0 px-4 pt-2">
          <MoveConfirm moveConfirmation={moveConfirmation} />
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-2 border-t border-hairline px-4 py-3">
        {current.canDelete ? (
          <Button
            aria-busy={current.busy}
            onClick={() => void current.remove()}
            size="sm"
            variant="danger"
          >
            Delete
          </Button>
        ) : null}
        <StepControl steps={steps} />
        <div className="flex-1" />
        <Button onClick={onClose} size="sm" variant="ghost">
          Cancel
        </Button>
        {current.readOnly ? null : (
          <Button
            aria-busy={current.busy}
            // An older step on show is kept or left before anything is written.
            disabled={moveConfirmation.pending !== null || write.busy || previewing}
            onClick={() => void current.save()}
            size="sm"
            variant="primary"
          >
            Save
          </Button>
        )}
      </div>
    </>
  );
}
