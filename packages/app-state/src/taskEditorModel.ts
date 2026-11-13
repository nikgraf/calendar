import {
  appendLink,
  byDayError,
  convertSourceOf,
  defaultTodoList,
  repeatUntilError,
  type EventRecord,
  eventToTaskLossSummary,
  isEventToTaskLossy,
  isTaskMoveLossy,
  type RecurringScope,
  type TaskConvertValues,
  type TaskDraft,
  type TaskListInfo,
  taskMoveLossSummary,
  type TaskPriority,
  type TaskProvider,
  type TaskRecord,
  taskListKeyOf,
  type TodoKind,
} from '@calendar/core';
import { useState } from 'react';
import { deleteTaskQuestion } from './deleteQuestion.ts';
import { reminderAlarmLabel } from './draftExtras.ts';
import type { EditorConfirmRequest } from './editorModel.ts';
import { CONVERT_SCOPE_HINT } from './editorOptions.ts';
import { useBackendMutations, useTaskReadOnlyLookup } from './hooks.ts';
import { useOneWrite } from './oneWrite.ts';
import {
  type RepeatFields,
  repeatNumberError,
  seedRepeatFields,
  useRepeatState,
} from './repeatState.ts';
import { offeredTaskLists, taskEditorChanges, type TaskEditorValues } from './taskEditorChanges.ts';

export interface TaskEditorSeed {
  /**
   * The event this (otherwise new) task replaces: Save converts it — the
   * task is created from the form, then the event is deleted (of a series,
   * what the carry stood for: see `setConvertScope`) — after confirming
   * what the event holds that a task cannot.
   */
  readonly convertFromEvent?: EventRecord | undefined;
  /** Creates: start without a due day (an inbox add); default true. */
  readonly dated?: boolean | undefined;
  /** Present when editing; absent for create. */
  readonly existing?: TaskRecord | undefined;
  /** Default due day for creates ('YYYY-MM-DD') — usually the focused day. */
  readonly initialDate: string;
  /**
   * Due time for creates ('HH:MM'), from a slot drawn on the time grid.
   * Only a Reminders list keeps it; Google Tasks are date-only.
   */
  readonly initialTime?: string | undefined;
  /** Creates: a task or a reminder, which picks the default list's provider (see `listKey`). */
  readonly kind?: TodoKind | undefined;
  /**
   * Creates: the list to open in (`accountId:listId`), when the caller
   * knows one (the Tasks tab's filter); otherwise the kind's default list
   * (`defaultTodoList`: the last one created in, then Reminders over Google).
   */
  readonly listKey?: string | undefined;
  /** Creates: the title to open with. */
  readonly title?: string | undefined;
}

const listKeyOf = (accountId: string, listId: string) => `${accountId}:${listId}`;

/**
 * The Reminders-only fields the form holds — kept whatever list is
 * picked, see `useTaskEditorModel` — as a thread keeps them per draft, so
 * one reminder's alerts, priority, rule and link never follow the form to
 * the next draft, and "Add all" writes each with its own.
 */
export interface ReminderFields {
  /** Minutes relative to the due time, the form's own first. */
  readonly alarms: ReadonlyArray<number>;
  readonly priority?: TaskPriority | undefined;
  /** The repeat fields as typed, so an invalid number stays one: Save would refuse it. */
  readonly repeat: RepeatFields;
  /** As typed: trimmed (and checked) when written. */
  readonly url: string;
}

/**
 * The list the last to-do was created in, for this session: a new one
 * defaults to it, like a new event defaults to its last calendar.
 */
let lastUsedTaskListKey: string | null = null;
export const rememberTaskList = (listKey: string): void => {
  lastUsedTaskListKey = listKey;
};
export const getLastUsedTaskListKey = (): string | null => lastUsedTaskListKey;

/** Alarm offsets the Reminders form offers (minutes relative to the due time). */
export const REMINDER_ALARM_OPTIONS: ReadonlyArray<{ label: string; value: number | undefined }> = [
  { label: 'None', value: undefined },
  { label: 'At time', value: 0 },
  { label: '5 min before', value: -5 },
  { label: '15 min before', value: -15 },
  { label: '1 hour before', value: -60 },
  { label: '1 day before', value: -1440 },
];

/**
 * The alerts the form offers, with the one a reminder holds where the
 * presets lack it (one the Assistant set, or Reminders.app did) in its
 * place by time: the picker shows the alert that will be written.
 */
export const reminderAlarmOptions = (
  alarm: number | undefined,
): ReadonlyArray<{ label: string; value: number | undefined }> => {
  if (alarm === undefined || REMINDER_ALARM_OPTIONS.some((option) => option.value === alarm)) {
    return REMINDER_ALARM_OPTIONS;
  }
  const own = { label: reminderAlarmLabel(alarm), value: alarm };
  const later = REMINDER_ALARM_OPTIONS.findIndex(
    (option) => option.value !== undefined && option.value < alarm,
  );
  const at = later === -1 ? REMINDER_ALARM_OPTIONS.length : later;
  return [...REMINDER_ALARM_OPTIONS.slice(0, at), own, ...REMINDER_ALARM_OPTIONS.slice(at)];
};

export const REMINDER_PRIORITY_OPTIONS: ReadonlyArray<{
  label: string;
  value: TaskPriority | undefined;
}> = [
  { label: 'None', value: undefined },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
];

const TIME_RE = /^\d{2}:\d{2}$/;

/** Whether a task form starts timed, and at what time. */
export const seedDueTiming = (seed: TaskEditorSeed): { dueTime: string; timed: boolean } =>
  seed.existing
    ? { dueTime: seed.existing.dueTime ?? '09:00', timed: seed.existing.dueTime !== undefined }
    : { dueTime: seed.initialTime ?? '09:00', timed: seed.initialTime !== undefined };

/**
 * Shared editor state for the Task and Reminder kinds of both platforms'
 * edit sheets — the small sibling of useEventEditorModel. The selected
 * list decides the provider, and the provider decides the form: Google
 * Tasks are title / due day / notes; Apple Reminders add a due time,
 * priority, URL, an alarm and a repeat rule. The list picker offers the
 * selected provider's lists (the Task | Reminder switch moves between
 * providers, see `switchEditorMode`); picking a list in another account
 * or provider moves the task on Save (a copy into the target and a
 * delete of the source, after `confirm` when the target cannot hold
 * everything); between two Reminders lists it re-homes in place. A new
 * task gets a due day unless the seed says otherwise (the Tasks tab's
 * "+"); any task's day can be taken away (`clearDueDate`), and a
 * reminder's time and repeat rule go with it. An existing undated one
 * (made in Reminders or Google Tasks; the calendar draws it on today)
 * opens as "no due date" and stays that way unless a day is added:
 * showing it today is not a due day, and Save must not turn it into one.
 */
export const useTaskEditorModel = ({
  confirm,
  onClose,
  onSaved,
  seed,
  taskLists,
}: {
  /** Asks before a move or conversion that drops fields; resolves false to leave things as they are. */
  confirm: (request: EditorConfirmRequest) => Promise<boolean>;
  onClose: () => void;
  /** Save went through (see the event model); not called for a delete. */
  onSaved?: (() => void) | undefined;
  seed: TaskEditorSeed;
  taskLists: ReadonlyArray<TaskListInfo>;
}) => {
  const mutations = useBackendMutations();
  const isTaskReadOnly = useTaskReadOnlyLookup();
  const existing = seed.existing;
  const [title, setTitle] = useState(existing?.title ?? seed.title ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? seed.initialDate);
  const [dated, setDated] = useState(
    existing === undefined ? seed.dated !== false : existing.dueDate !== undefined,
  );
  const [listKey, setListKey] = useState(() => {
    if (existing) {
      return listKeyOf(existing.accountId, existing.listId);
    }
    const target = defaultTodoList(offeredTaskLists(taskLists, undefined), {
      filter: seed.listKey,
      kind: seed.kind,
      lastUsedKey: lastUsedTaskListKey,
    });
    return target ? taskListKeyOf(target) : '';
  });
  // Reminders-only state. Kept even while a Google list is selected so a
  // flip between lists in create mode does not lose what was typed.
  const [timed, setTimed] = useState(() => seedDueTiming(seed).timed);
  const [dueTime, setDueTime] = useState(() => seedDueTiming(seed).dueTime);
  const [priority, setPriority] = useState<TaskPriority | undefined>(existing?.priority);
  const [url, setUrl] = useState(existing?.url ?? '');
  // The form edits the FIRST relative alert; any further alerts the user
  // set in Reminders.app (or an event's other notifications carried in)
  // ride along untouched.
  const [initialAlarms] = useState<ReadonlyArray<number>>(() => existing?.alarms ?? []);
  const [alarm, setAlarm] = useState<number | undefined>(initialAlarms[0]);
  const [extraAlarms, setExtraAlarms] = useState<ReadonlyArray<number>>(() =>
    initialAlarms.slice(1),
  );
  const { toSpec: repeatSpec, ...repeatState } = useRepeatState(existing?.recurrence, dueDate);
  // What the form opened with: Save sends only the fields that differ from
  // it (see taskEditorChanges) — captured once, not re-read from the row.
  const [initial] = useState<TaskEditorValues | undefined>(() =>
    existing
      ? {
          alarms: initialAlarms,
          dueDate: existing.dueDate,
          dueTime: existing.dueTime,
          listId: existing.listId,
          notes: existing.notes ?? '',
          priority: existing.priority,
          recurrence: existing.recurrence,
          title: existing.title,
          url: existing.url ?? '',
        }
      : undefined,
  );
  const [error, setError] = useState<string | null>(null);
  // How much of a series the fields carried from `convertFromEvent` stand
  // for: the event form's scope at the flip that carried them
  // (`switchEditorMode`), not as it is when Save runs.
  const [convertScope, setConvertScope] = useState<RecurringScope | undefined>(undefined);
  const write = useOneWrite();

  const offeredLists = offeredTaskLists(taskLists, existing);
  const selectedList = taskLists.find((list) => listKeyOf(list.accountId, list.id) === listKey);
  // The picked list's provider: it decides the form (and the kind the
  // shell shows, task or reminder).
  const provider: TaskProvider = selectedList?.provider ?? existing?.provider ?? 'google';
  const recurrenceUnsupported = existing?.recurrenceUnsupported === true;
  /** The task sits in a list EventKit will not let us write: the form is a viewer. */
  const readOnly = existing !== undefined && isTaskReadOnly(existing);
  /** Any writable task can move: to another Reminders list, account or provider. */
  const canMoveList = existing !== undefined && !readOnly;
  const alarms = () => [...(alarm === undefined ? [] : [alarm]), ...extraAlarms];
  /** The form's fields as a create/move draft for the selected provider. */
  const draft = (): TaskDraft => {
    const spec = repeatSpec();
    return {
      dueDate,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      title: title.trim(),
      ...(provider === 'apple'
        ? {
            ...(alarms().length === 0 ? {} : { alarms: alarms() }),
            ...(timed ? { dueTime } : {}),
            ...(priority === undefined ? {} : { priority }),
            ...(spec === undefined ? {} : { recurrence: spec }),
            ...(url.trim() ? { url: url.trim() } : {}),
          }
        : {}),
    };
  };

  /**
   * The draft for a create or a conversion. A link carried in from an
   * event (the URL field, which a Google list has no home for) rides in
   * the notes when the list it finally saves to is a Google one — decided
   * here, not at the flip, since the list can change in between. A move
   * keeps its own rule: a reminder's URL is named as lost there.
   */
  const newDraft = (): TaskDraft => {
    const base = draft();
    const link = url.trim();
    if (provider !== 'google' || link === '') {
      return base;
    }
    const notes = appendLink(base.notes, link);
    return notes === undefined ? base : { ...base, notes };
  };

  /** The form as a conversion source (see core `convert.ts`). */
  const values = (): TaskConvertValues => ({
    alarms: alarms(),
    completed: existing?.status === 'completed',
    dueDate,
    ...(timed ? { dueTime } : {}),
    notes: notes.trim(),
    priority,
    recurrence: repeatSpec(),
    recurrenceUnsupported,
    title: title.trim(),
    ...(url.trim() ? { url: url.trim() } : {}),
  });

  /**
   * Takes an event's fields over (a create-mode flip or a conversion).
   * The Reminders-only ones are set whatever list is selected, like the
   * rest of the state, so a later flip to a Reminders list finds them.
   */
  const adopt = (next: TaskConvertValues) => {
    setTitle(next.title);
    setNotes(next.notes);
    setDueDate(next.dueDate);
    setDated(true);
    setTimed(next.dueTime !== undefined);
    setDueTime(next.dueTime ?? '09:00');
    setAlarm(next.alarms[0]);
    setExtraAlarms(next.alarms.slice(1));
    setUrl(next.url ?? '');
    repeatState.resetRepeat(next.recurrence);
  };

  /** The Reminders-only fields as they stand, for a thread to keep with its draft. */
  const reminderFields = (): ReminderFields => ({
    alarms: alarms(),
    priority,
    repeat: repeatState.repeatFields,
    url,
  });

  /**
   * Another draft's Reminders-only fields take the form over (undefined: a
   * draft the form never showed as a to-do, which starts without any).
   */
  const restoreReminderFields = (next: ReminderFields | undefined) => {
    setAlarm(next?.alarms[0]);
    setExtraAlarms(next?.alarms.slice(1) ?? []);
    setPriority(next?.priority);
    setUrl(next?.url ?? '');
    repeatState.restoreRepeatFields(next?.repeat ?? seedRepeatFields(undefined));
  };

  /**
   * Takes a parsed phrase over the fields a phrase can say: the title,
   * the due day and whether there is a due time. The list, notes and the
   * Reminders-only fields stay as they are.
   */
  const applyPrefill = (next: {
    readonly date: string;
    readonly time?: string | undefined;
    readonly title: string;
  }) => {
    setTitle(next.title);
    setDueDate(next.date);
    setDated(true);
    setTimed(next.time !== undefined);
    setDueTime(next.time ?? '09:00');
    setError(null);
  };

  /** Why Save refuses the due day, a reminder's due time or its link as typed, or undefined. */
  const fieldError = (): string | undefined => {
    if (dated && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return 'A due date is required.';
    }
    if (provider === 'apple' && dated && timed && !TIME_RE.test(dueTime)) {
      return 'The due time must be HH:MM.';
    }
    if (provider === 'apple' && url.trim() && !URL.canParse(url.trim())) {
      return 'The URL is not valid.';
    }
    return undefined;
  };

  /** Why Save refuses a reminder's repeat rule as typed, or undefined. */
  const repeatError = (): string | undefined => {
    // An undated reminder does not repeat: its hidden rule is not saved.
    if (provider === 'apple' && dated && repeatState.repeat !== 'none') {
      return (
        repeatNumberError(repeatState.repeatInterval, 'The repeat interval') ??
        (repeatState.repeatEnds === 'after'
          ? repeatNumberError(repeatState.repeatCount, 'The occurrence count')
          : undefined) ??
        byDayError(repeatSpec() ?? { freq: repeatState.repeat }) ??
        repeatUntilError(repeatSpec() ?? {}, dueDate)
      );
    }
    return undefined;
  };

  /**
   * Whether Save moves the existing task to `accountId`/`taskListId` (a
   * copy into it and a delete of the source): not within its own list,
   * and not between two Reminders lists, where it re-homes in place.
   */
  const movesTo = (accountId: string, taskListId: string): boolean => {
    const sameList = existing?.accountId === accountId && existing?.listId === taskListId;
    const reHomesInPlace =
      existing?.provider === 'apple' && provider === 'apple' && existing.accountId === accountId;
    return !sameList && !reHomesInPlace;
  };

  /** The form as an update compares it with what it opened with (`taskEditorChanges`). */
  const currentValues = (taskListId: string): TaskEditorValues => ({
    alarms: alarms(),
    dueDate: dated ? dueDate : undefined,
    dueTime: dated && timed ? dueTime : undefined,
    listId: taskListId,
    notes: notes.trim(),
    priority,
    recurrence: repeatSpec(),
    title: title.trim(),
    url: url.trim(),
  });

  /** What a create sends: the new draft, into `accountId`/`taskListId`. */
  const createInput = (accountId: string, taskListId: string) => {
    // An undated create sends no due day at all (the draft's is the
    // form's default), and so no time or repeat rule either.
    const { dueDate: draftDue, dueTime: draftTime, recurrence: draftRule, ...rest } = newDraft();
    return {
      ...rest,
      accountId,
      ...(dated
        ? {
            dueDate: draftDue,
            ...(draftTime === undefined ? {} : { dueTime: draftTime }),
            ...(draftRule === undefined ? {} : { recurrence: draftRule }),
          }
        : {}),
      taskListId,
    };
  };

  const save = async () => {
    if (readOnly) {
      setError('This list is read-only in Reminders.');
      return;
    }
    const [accountId, taskListId] = listKey.split(':', 2);
    if (!title.trim() || !accountId || !taskListId) {
      setError('A title and task list are required.');
      return;
    }
    const invalid = fieldError() ?? repeatError();
    if (invalid) {
      setError(invalid);
      return;
    }
    try {
      const event = seed.convertFromEvent;
      if (!existing && event) {
        // A series as the carried fields took it: whole, or this occurrence.
        const source =
          convertScope === undefined ? undefined : convertSourceOf(event, convertScope);
        if (source === undefined) {
          setError(`${CONVERT_SCOPE_HINT}.`);
          return;
        }
        const target = { accountId, taskListId };
        // The stored event decides what is lost; ask before writing anything.
        const preview = await mutations.previewEventToTask({ ...source, target });
        const summary = eventToTaskLossSummary(
          preview.loss,
          provider === 'apple'
            ? 'Converting this event to a reminder'
            : 'Converting this event to a task',
        );
        if (
          isEventToTaskLossy(preview.loss) &&
          summary &&
          !(await confirm({ kind: 'convert', subject: 'event', summary }))
        ) {
          return;
        }
        await mutations.convertEventToTask({ ...source, draft: newDraft(), target });
      } else if (existing && movesTo(accountId, taskListId)) {
        // A move is a copy made from the form, and a copy needs a due day.
        if (!dated) {
          setError('Add a due date before moving this task to another list.');
          return;
        }
        // The backend knows the task's subtasks, which move with it.
        const loss = await mutations.previewMoveTask({
          accountId: existing.accountId,
          target: { accountId, taskListId },
          taskId: existing.id,
          taskListId: existing.listId,
        });
        const summary = taskMoveLossSummary(loss);
        // Ask before writing anything, so "keep it here" leaves no trace.
        if (
          isTaskMoveLossy(loss) &&
          summary &&
          !(await confirm({ kind: 'move', subject: 'task', summary }))
        ) {
          return;
        }
        await mutations.moveTask({
          accountId: existing.accountId,
          draft: draft(),
          target: { accountId, taskListId },
          taskId: existing.id,
          taskListId: existing.listId,
        });
      } else if (existing && initial) {
        const changes = taskEditorChanges({
          current: currentValues(taskListId),
          initial,
          provider,
          recurrenceUnsupported,
        });
        if (Object.keys(changes).length > 0) {
          await mutations.updateTask({
            accountId: existing.accountId,
            changes,
            taskId: existing.id,
            taskListId: existing.listId,
          });
        }
      } else {
        await mutations.createTask(createInput(accountId, taskListId));
        rememberTaskList(listKey);
      }
      onSaved?.();
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  const toggleCompletion = async (task: TaskRecord, confirmDiscard?: () => Promise<boolean>) => {
    try {
      if (confirmDiscard && !(await confirmDiscard())) {
        return;
      }
      await mutations.completeTask({
        accountId: task.accountId,
        status: task.status === 'completed' ? 'needsAction' : 'completed',
        taskId: task.id,
        taskListId: task.listId,
      });
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  const remove = async () => {
    if (!existing || readOnly) {
      return;
    }
    const address = {
      accountId: existing.accountId,
      taskId: existing.id,
      taskListId: existing.listId,
    };
    try {
      // The backend knows the task's subtasks, which go with it.
      const { subtasks } = await mutations.previewDeleteTask(address);
      if (
        !(await confirm({
          kind: 'delete',
          subject: 'task',
          summary: deleteTaskQuestion(existing.title, subtasks),
        }))
      ) {
        return;
      }
      await mutations.deleteTask(address);
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  return {
    /** Gives an undated task a due day (the form's date, today by default). */
    addDueDate: () => setDated(true),
    adopt,
    alarm,
    applyPrefill,
    /** Save, Delete and the completion action share one write at a time. */
    busy: write.busy,
    canMoveList,
    /**
     * Takes the due day away: the task is saved undated ("No due date")
     * and shown on today until done; a reminder's time and repeat rule go
     * with it. Not for a conversion, which keeps the event's day (its
     * draft always carries one), a read-only reminder, or one whose rule
     * the form cannot show (EventKit refuses a repeat without a day, and
     * that rule is never overwritten) — the control stays hidden there.
     */
    clearDueDate:
      seed.convertFromEvent === undefined && !readOnly && !recurrenceUnsupported
        ? () => setDated(false)
        : undefined,
    /** False for a task without a due day, until one is added. */
    dated,
    dueDate,
    dueTime,
    error,
    existing,
    listKey,
    notes,
    /** Every writable list of every provider (the Task | Reminder switch picks among them). */
    offeredLists,
    priority,
    provider,
    readOnly,
    recurrenceUnsupported,
    /** The Reminders-only fields, for a thread to keep with its draft. */
    reminderFields,
    remove: () => write.run(remove),
    ...repeatState,
    restoreReminderFields,
    save: () => write.run(save),
    setAlarm,
    /** The scope the fields a conversion carried in stand for (`switchEditorMode`). */
    setConvertScope,
    setDueDate,
    setDueTime,
    setListKey,
    setNotes,
    setPriority,
    setTimed,
    setTitle,
    setUrl,
    /** The picker's lists: the selected provider's, so a pick never changes the kind. */
    taskLists: offeredLists.filter((list) => list.provider === provider),
    timed,
    title,
    // Completion acts on the saved item. A pending move shows a different destination.
    toggleCompletion:
      existing && !readOnly && listKey === listKeyOf(existing.accountId, existing.listId)
        ? (confirmDiscard?: () => Promise<boolean>) =>
            write.run(() => toggleCompletion(existing, confirmDiscard))
        : undefined,
    url,
    values,
  };
};
