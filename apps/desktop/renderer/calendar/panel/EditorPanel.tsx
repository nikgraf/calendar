import { type CaptureSource, ModelUnavailableError, parseQuickAdd } from '@calendar/ai';
import {
  type DraftPreview,
  draftPreview,
  type EditorSourceKind,
  editorTitle,
  eventDraftFromPrefill,
  previewOfPrefill,
  type QuickAddItem,
  useBackendMutations,
  useDraftThread,
  useEditorKinds,
  useEventEditorModel,
  useMoveConfirmation,
  useOneWrite,
  useTaskEditorModel,
  type EventEditorSeed,
  type TaskEditorSeed,
} from '@calendar/app-state';
import {
  type CalendarInfo,
  type ItemKind,
  type TaskListInfo,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { useEffect, useRef } from 'react';
import { desktopLanguageModel } from '../../ai/desktopModel.ts';
import { Button } from '../../ui/Button.tsx';
import { IconButton } from '../../ui/IconButton.tsx';
import { ChevronLeftIcon, ChevronRightIcon, VideoIcon } from '../../ui/icons.tsx';
import { SegmentedControl } from '../../ui/SegmentedControl.tsx';
import { EventEditorForm } from '../EventEditorForm.tsx';
import { MoveConfirm } from '../MoveConfirm.tsx';
import { QuickAddBar } from '../QuickAddBar.tsx';
import { ReminderEditorForm } from '../ReminderEditorForm.tsx';
import { TaskEditorForm } from '../TaskEditorForm.tsx';

/** Drafts an editor opens with already made — a capture's events, as one thread. */
export interface ThreadSeed {
  readonly items: ReadonlyArray<QuickAddItem>;
  readonly utterance: string;
}

/** Existing event (edit mode), a prefilled slot (create mode), or a thread of drafts. */
export type EditorSeed = EventEditorSeed & { readonly thread?: ThreadSeed | undefined };

/** A click on a draft block: the editor focuses that draft (the nonce makes each click count). */
export interface DraftFocusRequest {
  readonly id: string;
  readonly nonce: number;
}

const KIND_LABELS: Record<ItemKind, string> = {
  event: 'Event',
  reminder: 'Reminder',
  task: 'Task',
};

/** A draft whose calendar has no color yet (no writable calendar): a neutral hue. */
const NO_CALENDAR_COLOR = '#8a8a8a';

const CHANGE_PLACEHOLDER = 'Change it: "at 8", "Thursday instead", "call it…"';

/**
 * The side panel's editor: for a new item the quick-add field on top,
 * then the Event | Task | Reminder control (only the kinds something can
 * hold), then the form. In create mode the control picks the kind; on an
 * existing item it converts (Save writes the other kind and deletes the
 * source) or moves a to-do to the other provider. Both models stay
 * mounted so a flip keeps state. A question before a lossy switch, move,
 * conversion or delete is a footer below the scrolling body, on screen
 * whatever the scroll position (the kind control that asked may be at
 * the top, Save at the bottom).
 *
 * A new item is a thread (`useDraftThread`): the first phrase makes the
 * draft(s), every later phrase in the same field changes them, Undo takes
 * a turn back, and the calendar draws every draft hatched (`onPreview`),
 * the focused one outlined and scrolled to (`onReveal`). The form is the
 * focused draft's view: its edits go back into the thread, and a focus
 * change (the pager, or a click on a block — `focusDraft`) swaps the form.
 * Save writes the focused draft; with several, "Add all" writes the rest
 * as they are and the focused one through the form. The e2e suite relies
 * on the title text ("New event", "Edit reminder", …), the mode test ids
 * and the `draft-*` test ids.
 */
export function EditorPanel({
  calendars,
  focusDraft,
  initialKind,
  onCapture,
  onClose,
  onPreview,
  onReveal,
  onSaved,
  quickAddFocus = 0,
  seed,
  task,
  taskLists,
  taskSeed,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  /** The latest click on a draft block, if any. */
  focusDraft?: DraftFocusRequest | null | undefined;
  /** The kind to open on: a to-do for a "+" that wants one, or Convert from the inspector. */
  initialKind?: ItemKind | undefined;
  /** A paste into the quick-add field that is an email or an image goes to capture. */
  onCapture: (source: CaptureSource) => void;
  onClose: () => void;
  /** The drafts to draw on the calendar, whenever they change; [] when the editor goes. */
  onPreview?: ((previews: ReadonlyArray<DraftPreview>) => void) | undefined;
  /** The focused draft's day: the calendar shows it. */
  onReveal?: ((date: Temporal.PlainDate) => void) | undefined;
  /** Save went through, as an event or a task. */
  onSaved?: (() => void) | undefined;
  /** ⌘K: bumped to focus the quick-add field of an open new-item editor. */
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
  const mutations = useBackendMutations();
  const thread = useDraftThread({ model: desktopLanguageModel, timeZone });
  const { drafts, focused, turns, version } = thread.state;
  const focusedDraft = drafts[focused];
  const threadRef = useRef(thread.state);
  threadRef.current = thread.state;

  // A save among several drafts writes the focused one and keeps the
  // editor open on the next: the model's own close is held back once.
  const keepOpen = useRef(false);
  const closingAll = useRef(false);
  const saved = () => {
    onSaved?.();
    const current = threadRef.current;
    if (current.drafts.length > 1 && !closingAll.current) {
      keepOpen.current = true;
      thread.remove(current.focused);
    }
  };
  const close = () => {
    if (keepOpen.current) {
      keepOpen.current = false;
      return;
    }
    onClose();
  };

  const taskModel = useTaskEditorModel({
    confirm: moveConfirmation.request,
    onClose: close,
    onSaved: saved,
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
    confirm: moveConfirmation.request,
    onClose: close,
    onSaved: saved,
    seed: { ...seed, convertFromTask: task },
    timeZone,
  });
  const { joinUrl } = eventModel;
  const kinds = useEditorKinds({
    calendars,
    confirm: moveConfirmation.request,
    eventModel,
    initialKind,
    previewEventToTask: mutations.previewEventToTask,
    sourceKind,
    taskLists,
    taskModel,
    timeZone,
  });
  const { apply, available, kind, mode, seriesOnly, switchTo } = kinds;

  /** The form as the thread's item: what a turn starts from and what the preview draws. */
  const currentItem = (): QuickAddItem =>
    mode === 'event'
      ? { kind: 'event', prefill: eventModel.toPrefill() }
      : {
          kind: 'task',
          prefill: {
            date: taskModel.dueDate,
            ...(taskModel.timed && taskModel.dueTime ? { time: taskModel.dueTime } : {}),
            title: taskModel.title,
          },
        };

  // Drafts the editor opened with (a capture) start the thread once.
  const { start } = thread;
  useEffect(() => {
    if (seed.thread) {
      start(seed.thread.items, seed.thread.utterance);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the panel is keyed per opening; the seed is read once
  }, []);

  // Whatever the thread did (a turn, an undo, a focus, a removal), the
  // form takes the focused draft over and the calendar shows its day.
  // The form's own edits leave the version alone, so they never re-apply.
  const applied = useRef(0);
  useEffect(() => {
    if (version === applied.current) {
      return;
    }
    applied.current = version;
    if (focusedDraft) {
      void apply(focusedDraft.item);
      onReveal?.(Temporal.PlainDate.from(focusedDraft.item.prefill.date));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the version names exactly what the form must take over
  }, [version]);

  /** Another draft takes the form; the form's edits stay on the one leaving it. */
  const switchFocus = (index: number) => {
    if (index === focused || drafts[index] === undefined) {
      return;
    }
    thread.update(focused, currentItem());
    thread.focus(index);
  };
  useEffect(() => {
    if (!focusDraft) {
      return;
    }
    const index = threadRef.current.drafts.findIndex((draft) => draft.id === focusDraft.id);
    if (index !== -1) {
      switchFocus(index);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a click is handled once, when it arrives
  }, [focusDraft?.nonce]);

  // The phrase goes to the thread: the first makes the draft(s), the rest
  // change them. The model's own failure modes become the field's message.
  const onPhrase = async (text: string): Promise<string | undefined> => {
    try {
      if (threadRef.current.drafts.length === 0) {
        const result = await parseQuickAdd(desktopLanguageModel, {
          fallbackDate: seed.initialDate.toString(),
          phrase: text,
          referenceDate: Temporal.Now.plainDateISO(timeZone).toString(),
          timeZone,
        });
        if (result.kind === 'rejected') {
          return result.reason;
        }
        thread.start(
          [
            result.kind === 'task'
              ? { kind: 'task', prefill: result.prefill }
              : { kind: 'event', prefill: result.prefill },
          ],
          text,
        );
        return undefined;
      }
      return await thread.refine(text, currentItem());
    } catch (error) {
      return error instanceof ModelUnavailableError
        ? 'On-device model unavailable.'
        : "That couldn't be read — try rephrasing.";
    }
  };

  // Every draft as the calendar draws it: the focused one from the live
  // form, the others as the thread holds them, all in the picked calendar's
  // color. Sent up only when something changed.
  const color =
    calendars.find((calendar) => `${calendar.accountId}:${calendar.id}` === eventModel.calendarKey)
      ?.colorHex ?? NO_CALENDAR_COLOR;
  const previews: ReadonlyArray<DraftPreview> = drafts.flatMap((draft, index) => {
    if (index === focused) {
      return mode === 'event'
        ? [previewOfPrefill(draft.id, eventModel.toPrefill(), { color, focused: true, timeZone })]
        : [];
    }
    const preview = draftPreview(draft, { color, focused: false, timeZone });
    return preview ? [preview] : [];
  });
  const previewKey = JSON.stringify(previews);
  useEffect(() => {
    onPreview?.(previews);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the previews' content
  }, [previewKey]);
  useEffect(
    () => () => {
      onPreview?.([]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the editor going is what clears the drafts
    [],
  );

  // "Add all": the other event drafts as they stand, then the focused one
  // through its form, which closes the editor. A to-do among the others
  // has no form here, so the button waits until each is the focused one.
  const write = useOneWrite();
  const canAddAll =
    drafts.length > 1 &&
    drafts.every((draft, index) => index === focused || draft.item.kind === 'event');
  const addAll = () =>
    write.run(async () => {
      const [accountId = '', calendarId = ''] = eventModel.calendarKey.split(':', 2);
      const current = threadRef.current;
      const others = current.drafts.filter((_, index) => index !== current.focused);
      for (const draft of others) {
        if (draft.item.kind === 'event') {
          await mutations.createEvent(
            eventDraftFromPrefill(draft.item.prefill, { accountId, calendarId, timeZone }),
          );
          // Written: out of the thread, so a failing form save cannot add it twice.
          thread.removeMany([draft.id]);
        }
      }
      closingAll.current = true;
      try {
        await (mode === 'event' ? eventModel.save() : taskModel.save());
      } finally {
        closingAll.current = false;
      }
    });

  const showToggle =
    available.length > 1 &&
    !(sourceKind === 'event' && eventModel.readOnly) &&
    !(sourceKind === 'task' && taskModel.readOnly);
  const { noun, verb } = editorTitle({ kind, sourceKind, sourceProvider: task?.provider });
  const title = `${verb} ${noun}`;
  const lastTurn = turns.at(-1);

  return (
    <div
      aria-label={mode === 'todo' ? 'Task editor' : 'Event editor'}
      className="flex min-h-0 flex-1 flex-col"
      data-testid="editor"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-3 pb-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold" data-testid="editor-title">
            {title}
          </h2>
          {joinUrl ? (
            <Button onClick={() => window.open(joinUrl, '_blank', 'noopener')} size="sm">
              <VideoIcon size={14} />
              Join meeting
            </Button>
          ) : null}
        </div>

        {sourceKind === 'new' ? (
          <QuickAddBar
            fallbackDate={seed.initialDate.toString()}
            focusSignal={quickAddFocus}
            onApply={(item) => void apply(item)}
            onCapture={onCapture}
            onPhrase={onPhrase}
            placeholder={drafts.length > 0 ? CHANGE_PLACEHOLDER : undefined}
            timeZone={timeZone}
          />
        ) : null}

        {turns.length > 0 ? (
          <div className="mb-3 flex flex-col gap-2" data-testid="draft-thread">
            <ol className="flex flex-col gap-1">
              {turns.map((turn) => (
                <li
                  className="flex items-start gap-2 rounded-control bg-fill px-2 py-1 text-xs"
                  data-testid="draft-turn"
                  key={turn.id}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">“{turn.utterance}”</span>
                    <span
                      className="block truncate text-ink-secondary"
                      data-testid="draft-turn-summary"
                    >
                      {turn.summary}
                    </span>
                  </span>
                  {turn === lastTurn ? (
                    <Button
                      data-testid="draft-undo"
                      disabled={thread.busy}
                      onClick={thread.undo}
                      size="sm"
                      variant="ghost"
                    >
                      Undo
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
            {drafts.length > 1 ? (
              <div className="flex items-center justify-between" data-testid="draft-pager">
                <div className="flex items-center gap-1">
                  <IconButton
                    data-testid="draft-prev"
                    disabled={focused === 0}
                    label="Previous draft"
                    onClick={() => switchFocus(focused - 1)}
                    size="sm"
                  >
                    <ChevronLeftIcon size={14} />
                  </IconButton>
                  <span className="text-xs text-ink-secondary" data-testid="draft-position">
                    {focused + 1} of {drafts.length}
                  </span>
                  <IconButton
                    data-testid="draft-next"
                    disabled={focused >= drafts.length - 1}
                    label="Next draft"
                    onClick={() => switchFocus(focused + 1)}
                    size="sm"
                  >
                    <ChevronRightIcon size={14} />
                  </IconButton>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    data-testid="draft-remove"
                    onClick={() => thread.remove(focused)}
                    size="sm"
                    variant="ghost"
                  >
                    Remove
                  </Button>
                  {canAddAll ? (
                    <Button
                      aria-busy={write.busy}
                      data-testid="draft-add-all"
                      disabled={moveConfirmation.pending !== null}
                      onClick={() => void addAll()}
                      size="sm"
                      variant="primary"
                    >
                      Add all {drafts.length}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {showToggle ? (
          <SegmentedControl
            className="mb-3 w-full"
            grow
            label="Kind"
            onChange={(option) => void switchTo(option)}
            options={available.map((option) => ({
              disabled: moveConfirmation.pending !== null || (option !== 'event' && seriesOnly),
              label: KIND_LABELS[option],
              testId: `mode-${option}`,
              title:
                option !== 'event' && seriesOnly
                  ? 'Choose "All events" to convert a series'
                  : undefined,
              value: option,
            }))}
            size="sm"
            value={kind}
          />
        ) : null}

        {mode === 'todo' ? (
          // The selected list's provider picks the form: a Reminders list
          // exposes time/priority/alert/repeat/URL; a Google list gets the
          // plain title/date/notes form. The kind control moves between the
          // providers; the list picker stays within one.
          taskModel.provider === 'apple' ? (
            <ReminderEditorForm
              moveConfirmation={moveConfirmation}
              onClose={onClose}
              task={task}
              taskModel={taskModel}
            />
          ) : (
            <TaskEditorForm
              moveConfirmation={moveConfirmation}
              onClose={onClose}
              task={task}
              taskModel={taskModel}
            />
          )
        ) : (
          <EventEditorForm
            model={eventModel}
            moveConfirmation={moveConfirmation}
            onClose={onClose}
          />
        )}
      </div>
      {moveConfirmation.pending ? (
        <div className="shrink-0 px-4 pt-2 pb-4">
          <MoveConfirm moveConfirmation={moveConfirmation} />
        </div>
      ) : null}
    </div>
  );
}
