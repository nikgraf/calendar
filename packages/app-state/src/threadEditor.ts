import { type FinderReader, ModelUnavailableError, type PhraseReader } from '@calendar/ai';
import {
  type BackendClient,
  type CalendarInfo,
  type Contact,
  type FreeSlot,
  type PlaceCandidate,
  type ItemKind,
  type RecurringScope,
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
  wasPreview,
} from './draftPreview.ts';
import type { DraftField, DraftKeeps } from './draftChanges.ts';
import {
  type Draft,
  type DraftExtras,
  type FormSnapshot,
  type HandStep,
  stepRule,
  threadLine,
  updateDraft,
  useDraftThread,
} from './draftThread.ts';
import {
  type EditorConfirmRequest,
  type EventEditorPrefill,
  type EventEditorSeed,
  seedTimeFields,
  useEventEditorModel,
} from './editorModel.ts';
import { useEditorKinds } from './editorKinds.ts';
import type { EditorSourceKind } from './editorSwitch.ts';
import { livePlaceChoice } from './draftPlaces.ts';
import { editorQuestions } from './draftQuestions.ts';
import { rescheduledEventExclusion } from './findTimeModel.ts';
import { useBackendMutations } from './hooks.ts';
import { useOneWrite } from './oneWrite.ts';
import type { QuickAddItem } from './quickAddItem.ts';
import { type TaskEditorSeed, useTaskEditorModel } from './taskEditorModel.ts';
import {
  guestsRefusal,
  todoAlertRefusal,
  todoTimeRefusal,
  type TurnLimits,
  turnRefusal,
} from './threadRefusal.ts';
import { movedFrom, shownMarks } from './threadSteps.ts';

export type { DraftFocusRequest } from './draftAtoms.ts';

/** Drafts an editor opens with already made — a capture's events, as one thread. */
export interface ThreadSeed {
  readonly items: ReadonlyArray<QuickAddItem>;
  /** A caveat about the drafts, shown with the thread (the text was cut short). */
  readonly note?: string | undefined;
  readonly utterance: string;
}

/**
 * A part of the form a step can change, which the form then marks (the
 * editor's `marks`): a draft's own fields, its guests, notes and
 * notifications.
 */
export type FlashField = DraftField | 'guests' | 'notes' | 'reminders';

/**
 * Existing event (edit mode), a prefilled slot (create mode), or a thread
 * of drafts. The Create with AI lesson opens a new item with a phrase
 * already in the quick-add field (`quickAddText`) and its frame above it
 * (`lesson`).
 */
export type EditorSeed = EventEditorSeed & {
  readonly lesson?: 'create' | undefined;
  readonly quickAddText?: string | undefined;
  readonly thread?: ThreadSeed | undefined;
};

/** A draft whose calendar has no color yet (no writable calendar): a neutral hue. */
const NO_CALENDAR_COLOR = '#8a8a8a';

/**
 * The calls a person makes by hand in the event form. A turn fills the
 * form through other doors (`applyPrefill`, `restoreExtras`, the editor's
 * own slot moves), so these tell the two apart.
 */
const EVENT_EDITS = [
  'addAttendee',
  'addReminder',
  'applyPlace',
  'applySlot',
  'keepLocationText',
  'pickPlace',
  'removeAttendee',
  'removeReminder',
  'setCalendarKey',
  'setDate',
  'setDescription',
  'setEndDate',
  'setEndTime',
  'setIsAllDay',
  'setLocation',
  'setReminderMinutes',
  'setRepeat',
  'setRepeatCount',
  'setRepeatEnds',
  'setRepeatInterval',
  'setRepeatMonthly',
  'setRepeatOrdinal',
  'setRepeatOrdinalWeekday',
  'setRepeatUntil',
  'setStartTime',
  'setTitle',
  'setUseDefaultReminders',
  'toggleWeekday',
] as const satisfies ReadonlyArray<keyof ReturnType<typeof useEventEditorModel>>;

/** …and in the to-do form. */
const TASK_EDITS = [
  'addDueDate',
  'clearDueDate',
  'setAlarm',
  'setDueDate',
  'setDueTime',
  'setListKey',
  'setNotes',
  'setPriority',
  'setRepeat',
  'setRepeatCount',
  'setRepeatEnds',
  'setRepeatInterval',
  'setRepeatMonthly',
  'setRepeatOrdinal',
  'setRepeatOrdinalWeekday',
  'setRepeatUntil',
  'setTimed',
  'setTitle',
  'setUrl',
  'toggleWeekday',
] as const satisfies ReadonlyArray<keyof ReturnType<typeof useTaskEditorModel>>;

/** A call's result that answers later. */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  'then' in value &&
  typeof value.then === 'function';

/**
 * The model with each of `edits` reporting its call first — the form's
 * hand edits, as the forms receive the model; the editor's own calls go
 * to the model itself and report nothing. A call that answers later (a
 * picked place's coordinates, a kind switch that asks first) reports
 * again once it has: what it changed is in the form only then.
 */
export const reportingEdits = <Model extends object>(
  model: Model,
  edits: ReadonlyArray<keyof Model>,
  onEdit: () => void,
): Model => {
  const reporting = { ...model };
  for (const key of edits) {
    const call = model[key];
    if (typeof call === 'function') {
      reporting[key] = ((...args: Array<unknown>) => {
        onEdit();
        const result = (call as (...args: Array<unknown>) => unknown)(...args);
        if (isThenable(result)) {
          // Either way it settles: a refusal changed nothing, which reads as nothing.
          void Promise.resolve(result).then(onEdit, onEdit);
        }
        return result;
      }) as Model[typeof key];
    }
  }
  return reporting;
};

/** The same day and hours: where the calendar would draw the two is the same place. */
const sameWhen = (one: EventEditorPrefill, other: EventEditorPrefill): boolean =>
  one.date === other.date &&
  (one.endDate ?? one.date) === (other.endDate ?? other.date) &&
  one.isAllDay === other.isAllDay &&
  (one.isAllDay || (one.startTime === other.startTime && one.endTime === other.endTime));

/**
 * Every draft as the calendar draws it: the focused one from the live
 * form (`live`, an event — a to-do draws nothing) in the calendar the
 * form has picked, with the free slots offered beside it as candidates
 * and, when the step on show moved it, an outline where it stood before
 * (`movedFrom`); the others as the thread holds them, each in the color
 * of the calendar it would be written to (its own, else the form's —
 * `draftCalendarKey`).
 */
export const threadPreviews = (
  drafts: ReadonlyArray<Draft>,
  focused: number,
  live: QuickAddItem,
  {
    calendarKey,
    calendars,
    movedFrom,
    saved,
    timeZone,
  }: {
    /** The form's calendar. */
    readonly calendarKey: string;
    readonly calendars: ReadonlyArray<CalendarInfo>;
    /**
     * The focused draft as it was before the step on show, when that step
     * changed its day or hours: where it stood is outlined. Not where a
     * saved event still stands — its own block is the trace there — and
     * not when the form is back at that place.
     */
    readonly movedFrom?: Draft | undefined;
    /**
     * A saved event's thread: the event as it opened, and whether the form
     * is at one occurrence of a series. The calendar draws the event
     * itself, so its draft is drawn only once it is somewhere else — the
     * event's own block then shows where it was — and, at one occurrence,
     * without the series' rule.
     */
    readonly saved?:
      | { readonly instance: boolean; readonly opened: QuickAddItem | undefined }
      | undefined;
    readonly timeZone: string;
  },
): ReadonlyArray<DraftPreview> => {
  const colorOf = (key: string) =>
    calendars.find((calendar) => `${calendar.accountId}:${calendar.id}` === key)?.colorHex ??
    NO_CALENDAR_COLOR;
  return drafts.flatMap((draft, index) => {
    if (index === focused) {
      if (live.kind !== 'event') {
        return [];
      }
      const color = colorOf(calendarKey);
      const candidates = candidatePreviews(draft, live.prefill, { color });
      if (saved?.opened?.kind === 'event' && sameWhen(saved.opened.prefill, live.prefill)) {
        return candidates;
      }
      const preview = previewOfPrefill(draft.id, live.prefill, { color, focused: true, timeZone });
      const { recurrence: _rule, ...once } = preview;
      const was =
        movedFrom?.item.kind === 'event' &&
        !sameWhen(movedFrom.item.prefill, live.prefill) &&
        !(saved?.opened?.kind === 'event' && sameWhen(saved.opened.prefill, movedFrom.item.prefill))
          ? wasPreview(movedFrom, { color, timeZone })
          : undefined;
      return [saved?.instance ? once : preview, ...candidates, ...(was ? [was] : [])];
    }
    const color = colorOf(draftCalendarKey(draft, calendars, calendarKey));
    const preview = draftPreview(draft, { color, focused: false, timeZone });
    return preview ? [preview] : [];
  });
};

/**
 * Runs `then` once each time `value` has become another one — never for
 * the value the editor opened with. For what the thread holds that was
 * right only under a value of the form's: the scope its free slots were
 * searched at, the rule its states were seeded with.
 */
const useOnChange = (value: RecurringScope | string | undefined, then: () => void): void => {
  const seen = useRef(value);
  useEffect(() => {
    if (seen.current !== value) {
      seen.current = value;
      then();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a change is handled once, when it happens
  }, [value]);
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
/** A calendar's default popup notifications, minutes before; undefined where it has none on record (Apple). */
const defaultMinutesOf = (
  calendars: ReadonlyArray<CalendarInfo>,
  key: string,
): ReadonlyArray<number> | undefined =>
  calendars
    .find((calendar) => `${calendar.accountId}:${calendar.id}` === key)
    ?.defaultReminders?.filter((override) => override.method === 'popup')
    .map((override) => override.minutes);

export const useThreadEditor = ({
  backend,
  calendars,
  confirm,
  finder,
  initialKind,
  onClose,
  onSaved,
  reader,
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
  /** How a finder phrase is read (`tunedFinder` or `rulesFinder`). */
  readonly finder: FinderReader;
  /** The kind to open on: a to-do for a "+" that wants one, or Convert. */
  readonly initialKind?: ItemKind | undefined;
  readonly onClose: () => void;
  /** Save went through, as an event or a task. */
  readonly onSaved?: (() => void) | undefined;
  /** How the Assistant reads a phrase: its own model, through `tunedReader`. */
  readonly reader: PhraseReader;
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
  // The form's calendar, where a draft that has none of its own would go (set below, once the form is made).
  const formCalendar = useRef('');
  const thread = useDraftThread({
    backend,
    defaultRemindersOf: (draft) =>
      defaultMinutesOf(calendars, draftCalendarKey(draft, calendars, formCalendar.current)),
    finder,
    reader,
    timeZone,
  });
  const { drafts, focused, version } = thread.state;
  const focusedDraft = drafts[focused];
  // An older step is on show (`stepTo`): the thread is a preview until
  // that step is kept or the newest is shown again.
  const previewing = thread.state.ahead.length > 0;
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
  formCalendar.current = eventModel.calendarKey;
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
  const writing = eventModel.busy || taskModel.busy || write.busy;
  // Nothing moves by hand while a write runs, nor while an older step is
  // on show: that one is looked at, and kept or left.
  const settled = !writing && !previewing;
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
  // The draft whose fields the form holds as rendered: set with the fields
  // themselves, so a reading names the draft it is of — after the focus
  // moved, the form shows the draft that left until it has taken the
  // other in.
  const [formOf, setFormOf] = useState<string | undefined>(undefined);
  const latest = useRef({ extras: currentExtras, item: currentItem, shown: formOf });
  latest.current = { extras: currentExtras, item: currentItem, shown: formOf };
  const readForm = (): FormSnapshot => ({
    extras: latest.current.extras(),
    item: latest.current.item(),
    ...(latest.current.shown === undefined ? {} : { shown: latest.current.shown }),
  });

  // Drafts the editor opened with (a capture) start the thread once.
  const { start } = thread;
  useEffect(() => {
    if (seed.thread) {
      start(seed.thread.items, seed.thread.utterance);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the editor is keyed per opening; the seed is read once
  }, []);

  // A saved item is the first state of its own thread (`openThread`): a
  // phrase changes it, an edit by hand is a step from the start, and the
  // state before the first step is the item as saved. It opens once the
  // form holds all the item opened with — a series waits for its master's
  // answer, since the rule that brings is the form's own and no edit. Not
  // for an item that cannot be written, nor an editor opened to convert
  // (its form switches kind as it opens).
  const opensConverting =
    sourceKind === 'event' && initialKind !== undefined && initialKind !== 'event';
  const savedOpen =
    (sourceKind === 'event' && !eventModel.readOnly && !opensConverting) ||
    (sourceKind === 'task' && !taskModel.readOnly);
  const assistant: 'new' | 'none' | 'saved' =
    sourceKind === 'new' ? 'new' : savedOpen ? 'saved' : 'none';
  const seedReady = assistant === 'saved' && (sourceKind === 'task' || eventModel.ruleAnswered);
  const { open } = thread;
  useEffect(() => {
    if (seedReady) {
      open(readForm());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the form has settled; the readers are the latest render's
  }, [seedReady]);

  // A to-do whose due date the form had cleared: a turn that leaves its
  // day alone must not put the day back (applying a prefill dates it).
  const undated = useRef<{ readonly date: string } | null>(null);

  /**
   * The draft the form shows, changed by a phrase, or the first one: the
   * form takes its item through the kind control's `apply` (a phrase read
   * as the other kind switches, with the switch's question), and what the
   * form holds beyond the item follows the draft. What the step changed
   * is marked from the thread itself (`shownMarks`), not from here.
   */
  const applyDraft = (draft: Draft, done: () => void) => {
    const { extras, item } = draft;
    void apply(item)
      .then(() => {
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
          if (extras?.reminder?.alarmsOnly) {
            // Only a turn's alert: what the switch of kind carried stays.
            taskModel.restoreAlarms(extras.reminder.alarms);
          } else if (extras?.reminder) {
            taskModel.restoreReminderFields(extras.reminder);
          }
          taskModel.setNotes(extras?.taskNotes ?? '');
          const placed = extras?.undated === false;
          if (!placed && (extras?.undated || undated.current?.date === item.prefill.date)) {
            taskModel.clearDueDate?.();
          }
        }
        undated.current = null;
      })
      .finally(done);
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
  // nothing undone can still be saved.
  const applied = useRef(0);
  const wasPreviewing = useRef(false);
  // The draft the form shows, by id; none before the first and after the last.
  const shown = useRef<string | undefined>(undefined);
  // The form is still taking the thread in while a version is unseen here
  // or an apply is open — a kind switch's question holds one open for as
  // long as it is asked. Counted, not compared: a new thread restarts the
  // version, and applies can settle out of order.
  const [seenVersion, setSeenVersion] = useState(version);
  const [openApplies, setOpenApplies] = useState(0);
  useEffect(() => {
    if (version === applied.current) {
      return;
    }
    applied.current = version;
    setSeenVersion(version);
    // A step put on show (`stepTo`: an older one, or forward again out of
    // a preview) is taken over exactly as it was — its kind, what the form
    // held for it — like another draft: nothing is carried over or asked.
    const restored = previewing || wasPreviewing.current;
    wasPreviewing.current = previewing;
    if (focusedDraft) {
      const another = shown.current !== undefined && shown.current !== focusedDraft.id;
      shown.current = focusedDraft.id;
      setFormOf(focusedDraft.id);
      if (another || restored) {
        showDraft(focusedDraft);
      } else {
        setOpenApplies((open) => open + 1);
        applyDraft(focusedDraft, () => setOpenApplies((open) => open - 1));
      }
      // A day the form cleared is stored as '' until repaired: nothing to show.
      try {
        reveal(Temporal.PlainDate.from(focusedDraft.item.prefill.date));
      } catch {
        // The form shows the field; the calendar stays where it is.
      }
    } else if (version > 0 && sourceKind === 'new') {
      shown.current = undefined;
      setFormOf(undefined);
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

  // Each edit made by hand in the form, counted: hands-free dictation
  // stops listening at the first one, and the thread reads the form once
  // the edit has rendered — what it changed is a step one can go back
  // over (`foldForm`). Not while the form is still taking a change of the
  // thread's in: its fields are then between two drafts. Once it has
  // taken one in, the form's own reading of that draft is kept as the
  // draft (no step): the next edit by hand is told from it exactly, and
  // not from how the thread happened to write the same values.
  const [userEdits, setUserEdits] = useState(0);
  const unread = useRef<HandStep | undefined>(undefined);
  const edited = (how: HandStep = { kind: 'edit' }) => {
    // A pick and the edits it makes are one step: the pick's.
    unread.current = unread.current?.kind === 'pick' ? unread.current : how;
    setUserEdits((count) => count + 1);
  };
  const applying = seenVersion !== version || openApplies > 0;
  const { record, update } = thread;
  const wasApplying = useRef(false);
  const endedPreview = useRef(false);
  useEffect(() => {
    const tookIn = (wasApplying.current && !applying) || (endedPreview.current && !previewing);
    wasApplying.current = applying;
    endedPreview.current = previewing;
    if (applying) {
      return;
    }
    const how = unread.current;
    unread.current = undefined;
    // An older step on show is locked: there is nothing by hand to read,
    // and what it holds stays as the thread kept it.
    if (previewing || threadRef.current.drafts.length === 0) {
      return;
    }
    const form = readForm();
    if (how !== undefined) {
      record(form, how);
    } else if (tookIn) {
      update(threadRef.current.focused, form.item, form.extras);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the count names the edits; the readers are the latest render's
  }, [userEdits, applying, previewing]);

  // The steps: one back or forward, or to one by its position; "Use this"
  // keeps the one on show and lets the later ones go. Not while a write
  // runs, a phrase is being read or the form is still taking a step in.
  const stepsLocked = thread.busy || writing || applying;
  // Which draft the form shows, and how many there are, stays as it is
  // while the form is between two states of one: the pager, Remove and
  // "Add all" wait for a write, an older step on show and an apply —
  // a kind switch's question holds one open for as long as it is asked.
  const draftsSettled = settled && !applying;
  // A kind switch by hand that asks first ("Switch to task?") leaves the
  // form between two kinds until it is answered: counted as an apply like
  // a phrase's own switch, so the focus, the steps and dictation wait.
  // Uncounted, the answer landed on whichever draft was focused by then.
  const switchKind: typeof kinds.switchTo = async (next) => {
    setOpenApplies((open) => open + 1);
    try {
      return await kinds.switchTo(next);
    } finally {
      setOpenApplies((open) => open - 1);
    }
  };
  const steps = {
    /** How many steps are applied: the one on show, counted from 1 (0: before the first). */
    at: thread.state.steps.length,
    back: () => {
      if (!stepsLocked) {
        thread.stepBy(-1);
      }
    },
    forward: () => {
      if (!stepsLocked) {
        thread.stepBy(1);
      }
    },
    /** Every step, oldest first, the ones stepped back over dimmed. */
    line: threadLine(thread.state),
    locked: stepsLocked,
    of: thread.state.steps.length + thread.state.ahead.length,
    show: (position: number) => {
      if (!stepsLocked) {
        thread.show(position);
      }
    },
    use: () => {
      if (!stepsLocked) {
        thread.keep();
        // Kept, the step on show is the newest: what lands next is a turn's, not a step put on show.
        wasPreviewing.current = false;
      }
    },
  };

  /**
   * The form moves into a free slot the thread offered (a chip, a
   * candidate block), and the calendar shows its day — a slot can lie
   * outside the days on view, and only a turn reveals on its own. A pick
   * by hand: it changes the date and times as the fields would.
   */
  const moveToSlot = (slot: FreeSlot) => {
    edited({ kind: 'pick', pick: 'slot' });
    eventModel.applySlot(slot);
    reveal(Temporal.PlainDate.from(slot.date));
  };

  /**
   * The names a turn invited that found no one contact, for the focused
   * event — only while its calendar can invite (an Apple calendar's form
   * cannot hold guests). Picking a contact puts the guest in the form;
   * the step that records it takes the name off the list, so going back
   * over the pick asks again. A name let go of just leaves the list.
   */
  const inviteeChoices =
    mode === 'event' && eventModel.canInvite ? (focusedDraft?.inviteeChoices ?? []) : [];
  const pickInvitee = (name: string, contact: Contact) => {
    if (!settled) {
      return;
    }
    edited({ kind: 'pick', name, pick: 'guest' });
    eventModel.addAttendee({ displayName: contact.displayName, email: contact.email });
  };
  const dismissInvitee = (name: string) => {
    if (settled) {
      thread.dropChoice(focused, name);
    }
  };

  /**
   * The places the focused event's last turn could have meant, the one
   * the field reads marked — while it reads that text or one of them
   * (`livePlaceChoice`). A pick makes a place the form's, pin and all,
   * as a hand edit; "as said" gives the text back as it was said, pin
   * gone. Either settles the choice (the step that records it takes it
   * off the draft, so going back over it asks again), as dismissing it
   * does.
   */
  const placeChoice =
    mode === 'event' ? livePlaceChoice(focusedDraft?.placeChoice, eventModel.location) : undefined;
  const pickPlaceChoice = (candidate: PlaceCandidate) => {
    if (!settled) {
      return;
    }
    edited({ kind: 'pick', pick: 'place' });
    eventModel.applyPlace(candidate.geo);
  };
  const keepPlace = () => {
    if (!settled || placeChoice === undefined) {
      return;
    }
    edited({ kind: 'pick', pick: 'place' });
    eventModel.keepLocationText(placeChoice.text);
  };
  /** The coordinates the form vouches for now, for the chips to tell a held place from its text. */
  const placeGeo = eventModel.extras().geo;
  const dismissPlace = () => {
    if (settled) {
      thread.dropPlace(focused);
    }
  };

  /**
   * What the Assistant asks about the focused draft, one at a time
   * (`draftQuestions.ts`): the place the field still reads, then the
   * names, numbered among those its turn brought. An answer is a pick
   * above; Skip leaves the form as it is and moves on to the next.
   */
  const questions = editorQuestions({
    applying,
    canInvite: eventModel.canInvite,
    draft: focusedDraft,
    event: mode === 'event',
    guests: inviteeChoices,
    livePlace: placeChoice,
  });
  const skipQuestion = () => {
    const { current } = questions;
    if (current?.kind === 'place') {
      dismissPlace();
    } else if (current?.kind === 'guest') {
      dismissInvitee(current.choice.name);
    }
  };

  /**
   * Another draft takes the form; the form's edits stay on the one leaving
   * it. Not mid-write, and not while the form is still taking a draft in
   * (a kind switch's question is open): its fields are between two drafts
   * then, and the answer would land on the draft focused meanwhile.
   */
  const switchFocus = (index: number) => {
    if (index === focused || drafts[index] === undefined || !settled || applying) {
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
  // What a stored event can take from a turn (`turnRefusal`): a new item
  // takes whatever the words say — but for a time on a to-do whose list
  // keeps none (`keepsTime`), which goes for a saved to-do too.
  const limits: TurnLimits | undefined =
    sourceKind === 'event' && eventModel.existing
      ? {
          canInvite: eventModel.canInvite,
          repeatEditable: eventModel.repeatLoaded,
          series: eventModel.openedOccurrence
            ? { opened: eventModel.openedOccurrence, scope: eventModel.scope }
            : undefined,
        }
      : undefined;
  /**
   * Whether a draft keeps a time of day: an event does, a to-do only on a
   * list that holds one — a Reminders list. A Google task has a due day
   * only, and Save sends no time: a turn that gives one is refused
   * (`todoTimeRefusal`), and the card shows none a draft carries from
   * elsewhere (a first phrase, a list switched since).
   */
  const keepsTime = (draft: Draft): boolean => {
    if (draft.item.kind !== 'task') {
      return true;
    }
    if (draft.id === focusedDraft?.id) {
      return taskModel.provider === 'apple';
    }
    const key = draftListKey(draft, taskLists, taskModel.listKey);
    return taskLists.find((list) => `${list.accountId}:${list.id}` === key)?.provider === 'apple';
  };
  /**
   * Whether a draft's guests are kept: an event's on a calendar that takes
   * a guest list. An Apple calendar's form holds none and its write
   * refuses one, so a turn that changes the guests there is refused
   * (`guestsRefusal`) and the card lists none a first phrase invited.
   */
  const keepsGuests = (draft: Draft): boolean => {
    if (draft.item.kind !== 'event' || draft.id === focusedDraft?.id) {
      return draft.item.kind !== 'event' || eventModel.canInvite;
    }
    const key = draftCalendarKey(draft, calendars, eventModel.calendarKey);
    const calendar = calendars.find((each) => `${each.accountId}:${each.id}` === key);
    return (calendar?.provider ?? 'google') === 'google';
  };
  /**
   * What of a draft is saved where it goes: what its card and row show
   * (`cardLines`, `describeDraft`). A to-do's alerts go where its time
   * does: only a Reminders list holds either.
   */
  const keeps = (draft: Draft): DraftKeeps => ({
    alerts: keepsTime(draft),
    guests: keepsGuests(draft),
    time: keepsTime(draft),
  });
  // A saved series' free slots were searched at the scope the form was at
  // ("All events" leaves the series' own occurrences out of the way, "This
  // event" only the one): at another scope they no longer hold, so they
  // are let go of, with a search still out. A new item has no scope.
  useOnChange(eventModel.scope, thread.dropSlots);
  // A saved series' rule that arrives after its thread opened (the master
  // was read late, or the rule changed elsewhere): the form has seeded
  // itself with it again by now, and the thread's states follow.
  useOnChange(eventModel.ruleKey, () => {
    const { item } = readForm();
    if (assistant !== 'saved' || item.kind !== 'event') {
      return;
    }
    // A step had given the item another rule than it opened with: that
    // one is the draft's still (`reseedRule` leaves it), so the form shows
    // it again — it seeded itself with the arrived rule, and Save would
    // send none.
    const kept = stepRule(threadRef.current);
    thread.reseedRule(item.prefill.recurrence);
    if (kept !== undefined) {
      eventModel.resetRepeat(kept.recurrence);
    }
  });
  const onPhrase = async (text: string): Promise<string | undefined> => {
    if (previewing) {
      return 'An earlier step is on show — use it or go forward first.';
    }
    try {
      const item = currentItem();
      // An undated to-do: its stored day is a placeholder the form had let go of.
      undated.current =
        threadRef.current.drafts.length > 0 && item.kind === 'task' && !taskModel.dated
          ? { date: item.prefill.date }
          : null;
      return await thread.phrase(text, {
        // A saved item's thread starts as that item: its words only change it.
        canStart: sourceKind === 'new',
        // The event being moved is not in its own way.
        exclude:
          sourceKind === 'event'
            ? rescheduledEventExclusion(
                eventModel.existing,
                eventModel.scope,
                eventModel.masterSeries,
              )
            : undefined,
        fallbackDate: seed.initialDate.toString(),
        read: readForm,
        refuse: (draft, after, guests, alerts) =>
          todoTimeRefusal(draft.item, after, keepsTime(draft)) ??
          todoAlertRefusal(after, alerts, keepsTime(draft)) ??
          (limits
            ? turnRefusal(draft.item, after, guests, limits)
            : guestsRefusal(guests, keepsGuests(draft))),
      });
    } catch (error) {
      return error instanceof ModelUnavailableError
        ? 'On-device model unavailable.'
        : "That couldn't be read — try rephrasing.";
    }
  };

  // What the step on show changed, for the form and the cards to mark.
  const labels = {
    calendar: (key: string) =>
      calendars.find((calendar) => `${calendar.accountId}:${calendar.id}` === key)?.summary ?? key,
    list: (key: string) =>
      taskLists.find((list) => `${list.accountId}:${list.id}` === key)?.title ?? key,
  };
  const marks = shownMarks(thread.state, labels);

  // The drafts as the calendar draws them, sent when something changed;
  // none once the editor goes.
  const liveItem = currentItem();
  const previews = threadPreviews(drafts, focused, liveItem, {
    calendarKey: eventModel.calendarKey,
    calendars,
    movedFrom: movedFrom(thread.state, marks),
    saved:
      assistant === 'saved'
        ? {
            instance: eventModel.isRecurring && eventModel.scope === 'instance',
            // The item as saved: the drafts before the first step, else the one there is.
            opened: (steps.line[0]?.before.drafts[0] ?? drafts[0])?.item,
          }
        : undefined,
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

  return {
    addAll,
    /** The form is still taking the thread's last change in: the next phrase waits. */
    applying,
    /**
     * Whether the assistant can work on what is open: a new item, a saved
     * one that can be written (its thread starts as that item), or not at
     * all (a read-only item, a birthday, an editor opened to convert).
     */
    assistant,
    batchError,
    canAddAll,
    /** A name let go of: no contact is picked for it. */
    dismissInvitee,
    /** The place row let go of; the field keeps what it reads. */
    dismissPlace,
    drafts,
    /** The pager, Remove and "Add all" may act: no write, no older step on show, no apply open. */
    draftsSettled,
    /** For the forms: the setters a person moves count as `userEdits`. */
    eventModel: reportingEdits(eventModel, EVENT_EDITS, edited),
    focused,
    focusedDraft,
    /** Names the focused event's turns invited that need a contact picked. */
    inviteeChoices,
    /** The location text back as said, pin gone; the row stays. */
    keepPlace,
    keeps,
    /** The kind control's switch counts as an edit too. */
    kinds: reportingEdits({ ...kinds, switchTo: switchKind }, ['switchTo'], edited),
    /** How a calendar or a list is named in a step's changes (`lineChanges`). */
    labels,
    liveItem,
    /** The fields the step on show changed, marked until another step is shown. */
    marks,
    moveToSlot,
    onPhrase,
    /** A contact picked for a name a turn invited: the guest joins the form. */
    pickInvitee,
    /** A place picked among a turn's candidates: the form takes its text and pin. */
    pickPlaceChoice,
    /** The places the focused event's last turn could have meant, the one the form holds among them. */
    placeChoice,
    /** The coordinates the form vouches for now: which chip is held, if any. */
    placeGeo,
    /** The question asked now and its number (`questionsAsked`). */
    questions,
    /** An older step is on show: the form is locked and Save is off until it is kept or left. */
    previewing,
    settled,
    /** The question on show let go of: the form stays as it is. */
    skipQuestion,
    /** The thread's steps and the way through them. */
    steps,
    switchFocus,
    taskModel: reportingEdits(taskModel, TASK_EDITS, edited),
    thread,
    /** Moves at each edit made by hand in the form (the phrase field's `editKey`: dictation ends). */
    userEdits,
    write,
  };
};
