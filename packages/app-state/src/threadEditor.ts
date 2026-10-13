import { type LanguageModel, ModelUnavailableError } from '@calendar/ai';
import {
  type BackendClient,
  type CalendarInfo,
  type FreeSlot,
  type ItemKind,
  type TaskListInfo,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { useEffect, useRef, useState } from 'react';
import { draftCalendarKey, draftListKey, planAddAll } from './addAll.ts';
import { useDraftFocusRequest, useRevealDraftDay, useSetDraftPreviews } from './draftAtoms.ts';
import {
  candidatePreviews,
  type DraftPreview,
  draftPreview,
  previewOfPrefill,
} from './draftPreview.ts';
import {
  changedDraftFields,
  type Draft,
  type DraftExtras,
  type DraftField,
  updateDraft,
  useDraftThread,
} from './draftThread.ts';
import {
  type EditorConfirmRequest,
  type EventEditorSeed,
  seedTimeFields,
  useEventEditorModel,
} from './editorModel.ts';
import { useEditorKinds } from './editorKinds.ts';
import type { EditorSourceKind } from './editorSwitch.ts';
import { useBackendMutations } from './hooks.ts';
import { useOneWrite } from './oneWrite.ts';
import type { QuickAddItem } from './quickAddItem.ts';
import { type TaskEditorSeed, useTaskEditorModel } from './taskEditorModel.ts';
import { useFleetingFlash } from './threadTurns.ts';

export type { DraftFocusRequest } from './draftAtoms.ts';

/** Drafts an editor opens with already made — a capture's events, as one thread. */
export interface ThreadSeed {
  readonly items: ReadonlyArray<QuickAddItem>;
  /** A caveat about the drafts, shown with the thread (the text was cut short). */
  readonly note?: string | undefined;
  readonly utterance: string;
}

/**
 * The fields a turn just changed in the form, for it to flash once: `key`
 * is the turn's id, so the same turn never flashes twice and the next one
 * always does.
 */
export interface DraftFlash {
  readonly fields: ReadonlySet<DraftField>;
  readonly key: string;
}

/** Existing event (edit mode), a prefilled slot (create mode), or a thread of drafts. */
export type EditorSeed = EventEditorSeed & { readonly thread?: ThreadSeed | undefined };

/** A draft whose calendar has no color yet (no writable calendar): a neutral hue. */
const NO_CALENDAR_COLOR = '#8a8a8a';

/**
 * Every draft as the calendar draws it: the focused one from the live
 * form (`live`, an event — a to-do draws nothing) in the calendar the
 * form has picked, with the free slots offered beside it as candidates;
 * the others as the thread holds them, each in the color of the calendar
 * it would be written to (its own, else the form's — `draftCalendarKey`).
 */
export const threadPreviews = (
  drafts: ReadonlyArray<Draft>,
  focused: number,
  live: QuickAddItem,
  {
    calendarKey,
    calendars,
    timeZone,
  }: {
    /** The form's calendar. */
    readonly calendarKey: string;
    readonly calendars: ReadonlyArray<CalendarInfo>;
    readonly timeZone: string;
  },
): ReadonlyArray<DraftPreview> => {
  const colorOf = (key: string) =>
    calendars.find((calendar) => `${calendar.accountId}:${calendar.id}` === key)?.colorHex ??
    NO_CALENDAR_COLOR;
  return drafts.flatMap((draft, index) => {
    if (index === focused) {
      const color = colorOf(calendarKey);
      return live.kind === 'event'
        ? [
            previewOfPrefill(draft.id, live.prefill, { color, focused: true, timeZone }),
            ...candidatePreviews(draft, live.prefill, { color }),
          ]
        : [];
    }
    const color = colorOf(draftCalendarKey(draft, calendars, calendarKey));
    const preview = draftPreview(draft, { color, focused: false, timeZone });
    return preview ? [preview] : [];
  });
};

/**
 * A new item's editor as a thread, shared by the desktop's side panel
 * and the iOS edit sheet: both editor models and the kind control, the
 * draft thread behind them, and everything between — the form takes the
 * focused draft over whenever the thread moves (a turn, an undo, a focus,
 * a removal) and its edits go back into the thread; a phrase goes to the
 * thread (a first one makes drafts, a later one changes them, one that
 * asks for free time proposes slots); each draft keeps the calendar or
 * list picked for it, and another draft taking the form shows as it was
 * left; a save among several drafts writes the focused one and keeps the
 * editor open on the next; "Add all" writes the others as they stand,
 * events and to-dos alike, then the focused one through its form. The
 * drafts are published for the calendar to draw (`useDraftPreviews`), the
 * focused draft's day is asked to be shown (`useOnDraftReveal`), and a
 * click on a draft block focuses it (`useRequestDraftFocus`).
 *
 * The platforms render it: the form, the turns, the pager, the chips.
 */
export const useThreadEditor = ({
  backend,
  calendars,
  confirm,
  initialKind,
  model,
  onClose,
  onSaved,
  seed,
  sourceKind,
  task,
  taskLists,
  taskSeed,
  timeZone,
}: {
  /** The events a finder phrase searches between. */
  readonly backend: BackendClient;
  readonly calendars: ReadonlyArray<CalendarInfo>;
  readonly confirm: (request: EditorConfirmRequest) => Promise<boolean>;
  /** The kind to open on: a to-do for a "+" that wants one, or Convert. */
  readonly initialKind?: ItemKind | undefined;
  readonly model: LanguageModel;
  readonly onClose: () => void;
  /** Save went through, as an event or a task. */
  readonly onSaved?: (() => void) | undefined;
  readonly seed: EditorSeed;
  readonly sourceKind: EditorSourceKind;
  /** Present when the editor was opened from a task (task edit mode). */
  readonly task?: TaskRecord | undefined;
  readonly taskLists: ReadonlyArray<TaskListInfo>;
  /** A new to-do's start: undated (an inbox add) and the list to open in. */
  readonly taskSeed?: Pick<TaskEditorSeed, 'dated' | 'listKey'> | undefined;
  readonly timeZone: string;
}) => {
  const mutations = useBackendMutations();
  const thread = useDraftThread({ backend, model, timeZone });
  const { drafts, focused, version } = thread.state;
  const focusedDraft = drafts[focused];
  const threadRef = useRef(thread.state);
  threadRef.current = thread.state;
  const reveal = useRevealDraftDay();
  const setPreviews = useSetDraftPreviews();
  const focusRequest = useDraftFocusRequest();

  // A save among several drafts writes the focused one and keeps the
  // editor open on the next: the model's own close is held back once. The
  // focus cannot move while a write runs (`settled` below), so the draft
  // removed is the one that was written.
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
    confirm,
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
    confirm,
    onClose: close,
    onSaved: saved,
    seed: { ...seed, convertFromTask: task },
    timeZone,
  });
  const kinds = useEditorKinds({
    calendars,
    confirm,
    eventModel,
    initialKind,
    previewEventToTask: mutations.previewEventToTask,
    sourceKind,
    taskLists,
    taskModel,
    timeZone,
  });
  const { apply, mode } = kinds;
  // "Add all" and a Save never overlap, and the focus stays put while
  // either runs: a draft written is the one that was shown.
  const write = useOneWrite();
  const settled = !eventModel.busy && !taskModel.busy && !write.busy;
  const [batchError, setBatchError] = useState<string | null>(null);

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
  /**
   * What the form holds beyond the item: the event form's extras, and the
   * calendar picked for an event — or a to-do's list, notes, undated state
   * and Reminders-only fields.
   */
  const currentExtras = (): DraftExtras => ({
    ...eventModel.extras(),
    ...(mode === 'event'
      ? { calendarKey: eventModel.calendarKey }
      : {
          listKey: taskModel.listKey,
          reminder: taskModel.reminderFields(),
          taskNotes: taskModel.notes,
          undated: !taskModel.dated,
        }),
  });
  // The latest render's readers, for a turn that reads the form after an await.
  const latest = useRef({ extras: currentExtras, item: currentItem });
  latest.current = { extras: currentExtras, item: currentItem };
  const readForm = () => ({ extras: latest.current.extras(), item: latest.current.item() });

  // Drafts the editor opened with (a capture) start the thread once.
  const { start } = thread;
  useEffect(() => {
    if (seed.thread) {
      start(seed.thread.items, seed.thread.utterance);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the editor is keyed per opening; the seed is read once
  }, []);

  // A to-do whose due date the form had cleared: a turn that leaves its
  // day alone must not put the day back (applying a prefill dates it).
  const undated = useRef<{ readonly date: string } | null>(null);

  /**
   * The draft the form shows, changed by a turn or an Undo, or the first
   * one: the form takes its item through the kind control's `apply` (a
   * phrase read as the other kind switches, with the switch's question),
   * the fields that changed flash, and what the form holds beyond the
   * item follows the draft — for an Undo, as the turn found it.
   */
  const applyDraft = (draft: Draft, landed: { readonly id: string } | undefined) => {
    const { extras, item } = draft;
    const before = currentItem();
    void apply(item).then((after) => {
      if (landed) {
        setFlash({ fields: new Set(changedDraftFields(before, after)), key: landed.id });
      }
      if (item.kind === 'task') {
        // A to-do's own: its list and Reminders-only fields where the form
        // had held it as one, its notes, and a day the form had let go of —
        // unless the thread dated it itself (a slot placement says so in
        // the extras; a retained time says nothing, a reminder keeps its
        // time while undated).
        const listKey = draftListKey(draft, taskLists, '');
        if (listKey !== '') {
          taskModel.setListKey(listKey);
        }
        if (extras?.reminder) {
          taskModel.restoreReminderFields(extras.reminder);
        }
        taskModel.setNotes(extras?.taskNotes ?? '');
        const placed = extras?.undated === false;
        if (!placed && (extras?.undated || undated.current?.date === item.prefill.date)) {
          taskModel.clearDueDate?.();
        }
      }
      undated.current = null;
    });
    // The form starts clean for a draft it never held: nothing typed
    // for another draft — guests, notes, notifications — follows it.
    eventModel.restoreExtras(extras);
  };

  /**
   * Another draft takes the form (a focus, a removal, an Undo that moved
   * the focus): it shows as it was left — its kind, its calendar or list,
   * everything the form held for it — or clean, in the calendar and list
   * the form has, for a draft it never held. Not a kind switch: nothing
   * carries over from the draft that left, nothing is asked.
   */
  const showDraft = (draft: Draft) => {
    const { extras, item } = draft;
    undated.current = null;
    eventModel.restoreExtras(extras);
    taskModel.setListKey(draftListKey(draft, taskLists, taskModel.listKey));
    taskModel.restoreReminderFields(extras?.reminder);
    taskModel.setNotes(extras?.taskNotes ?? '');
    if (kinds.show(item).kind === 'task' && extras?.undated) {
      taskModel.clearDueDate?.();
    }
  };

  // Whatever the thread did (a turn, an undo, a focus, a removal), the
  // form takes the focused draft over and the calendar shows its day.
  // The form's own edits leave the version alone, so they never re-apply.
  // Another draft than the one shown is shown as it was left (`showDraft`);
  // the same one changed by a turn or an Undo — or the first one, which
  // replaces what the form held before the phrase — is applied, which may
  // switch the kind and ask about a loss. The thread emptied (the first
  // turn undone): the form goes back to the blank it opened as, so
  // nothing undone can still be saved. A turn that landed (the list grew
  // — an Undo shrinks it, a focus or a removal leaves it) flashes the
  // fields it changed in the form as it stood.
  const applied = useRef(0);
  // The draft the form shows, by id; none before the first and after the last.
  const shown = useRef<string | undefined>(undefined);
  // A thread the editor opens with (a capture) fills a form that is only
  // appearing: its first turn counts as seen, nothing flashes.
  const turnsSeen = useRef(seed.thread ? 1 : 0);
  const [flash, setFlash] = useState<DraftFlash | null>(null);
  useEffect(() => {
    if (version === applied.current) {
      return;
    }
    applied.current = version;
    const { turns } = thread.state;
    const landed = turns.length > turnsSeen.current ? turns.at(-1) : undefined;
    turnsSeen.current = turns.length;
    if (focusedDraft) {
      const another = shown.current !== undefined && shown.current !== focusedDraft.id;
      shown.current = focusedDraft.id;
      if (another) {
        showDraft(focusedDraft);
      } else {
        applyDraft(focusedDraft, landed);
      }
      // A day the form cleared is stored as '' until repaired: nothing to show.
      try {
        reveal(Temporal.PlainDate.from(focusedDraft.item.prefill.date));
      } catch {
        // The form shows the field; the calendar stays where it is.
      }
    } else if (version > 0) {
      shown.current = undefined;
      const times = seedTimeFields({
        initialDate: seed.initialDate,
        ...(seed.initialHour === undefined ? {} : { initialHour: seed.initialHour }),
        ...(seed.initialTimes === undefined ? {} : { initialTimes: seed.initialTimes }),
      });
      eventModel.applyPrefill({
        date: seed.initialDate.toString(),
        endTime: times.endTime,
        isAllDay: false,
        startTime: times.startTime,
        title: '',
      });
      eventModel.restoreExtras(undefined);
      // The to-do form too, back to the blank it opened as.
      taskModel.applyPrefill({ date: seed.initialDate.toString(), title: '' });
      taskModel.setNotes('');
      taskModel.restoreReminderFields(undefined);
      if (taskSeed?.dated === false) {
        taskModel.clearDueDate?.();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the version names exactly what the form must take over
  }, [version]);

  /**
   * The form moves into a free slot the thread offered (a chip, a
   * candidate block), and the calendar shows its day — a slot can lie
   * outside the days on view, and only a turn reveals on its own.
   */
  const moveToSlot = (slot: FreeSlot) => {
    eventModel.applySlot(slot);
    reveal(Temporal.PlainDate.from(slot.date));
  };

  /** Another draft takes the form; the form's edits stay on the one leaving it. Not mid-write. */
  const switchFocus = (index: number) => {
    if (index === focused || drafts[index] === undefined || !settled) {
      return;
    }
    thread.update(focused, currentItem(), currentExtras());
    thread.focus(index);
  };
  useEffect(() => {
    if (!focusRequest) {
      return;
    }
    const index = threadRef.current.drafts.findIndex((draft) => draft.id === focusRequest.id);
    if (index !== -1) {
      // Mid-write the click is dropped (`switchFocus` checks), like the pager.
      switchFocus(index);
      // A candidate of the focused draft: the form moves into its slot.
      if (focusRequest.slot && index === focused && mode === 'event' && settled) {
        moveToSlot(focusRequest.slot);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a click is handled once, when it arrives
  }, [focusRequest?.nonce]);

  // The phrase goes to the thread: the first makes the draft(s), the rest
  // change them, one that asks for free time proposes slots. The model's
  // own failure modes become the field's message.
  const onPhrase = async (text: string): Promise<string | undefined> => {
    try {
      const item = currentItem();
      // An undated to-do: its stored day is a placeholder the form had let go of.
      undated.current =
        threadRef.current.drafts.length > 0 && item.kind === 'task' && !taskModel.dated
          ? { date: item.prefill.date }
          : null;
      return await thread.phrase(text, {
        fallbackDate: seed.initialDate.toString(),
        read: readForm,
      });
    } catch (error) {
      return error instanceof ModelUnavailableError
        ? 'On-device model unavailable.'
        : "That couldn't be read — try rephrasing.";
    }
  };

  // The drafts as the calendar draws them, sent when something changed;
  // none once the editor goes.
  const liveItem = currentItem();
  const previews = threadPreviews(drafts, focused, liveItem, {
    calendarKey: eventModel.calendarKey,
    calendars,
    timeZone,
  });
  const previewKey = JSON.stringify(previews);
  useEffect(() => {
    setPreviews(previews);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the previews' content
  }, [previewKey]);
  useEffect(
    () => () => {
      setPreviews([]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the editor going is what clears the drafts
    [],
  );

  // "Add all": the other drafts as they stand, events and to-dos alike,
  // each into the calendar or list picked for it (`planAddAll`) — each
  // checked as Save would check the form, the first one that fails shown
  // in the form with the reason — then the focused one through its form,
  // which closes the editor. A failed write stops the batch with its
  // reason; what was written has left the thread, the rest stays.
  const canAddAll = drafts.length > 1;
  const addAll = () =>
    write.run(async () => {
      setBatchError(null);
      // The form's edits go into the thread first: should the batch stop
      // short, the focused draft is still what the user last saw.
      const form = readForm();
      const current = updateDraft(
        threadRef.current,
        threadRef.current.focused,
        form.item,
        form.extras,
      );
      thread.update(current.focused, form.item, form.extras);
      const plan = planAddAll(current, {
        calendars,
        // A draft the form never showed goes where the form points now.
        defaults: { calendarKey: eventModel.calendarKey, listKey: taskModel.listKey },
        taskLists,
        timeZone,
      });
      if (plan.kind === 'blocked') {
        setBatchError(plan.reason);
        thread.focus(plan.index);
        return;
      }
      try {
        for (const planned of plan.writes) {
          await (planned.kind === 'event'
            ? mutations.createEvent(planned.event)
            : mutations.createTask(planned.task));
          // Written: out of the thread, so a failing form save cannot add it twice.
          thread.removeMany([planned.id]);
        }
      } catch (error) {
        setBatchError(String(error));
        return;
      }
      closingAll.current = true;
      try {
        await (mode === 'event' ? eventModel.save() : taskModel.save());
      } finally {
        closingAll.current = false;
      }
    });

  const playing = useFleetingFlash(flash);

  return {
    addAll,
    batchError,
    canAddAll,
    drafts,
    eventModel,
    /** The fields the last turn changed, for the form to flash — while the flash plays. */
    flash: playing,
    focused,
    focusedDraft,
    kinds,
    liveItem,
    moveToSlot,
    onPhrase,
    settled,
    switchFocus,
    taskModel,
    thread,
    turns: thread.state.turns,
    write,
  };
};
