import type { TaskListInfo, TaskPriority, TaskProvider, TaskRecord } from '@calendar/core';
import { useState } from 'react';
import { useBackendMutations } from './hooks.ts';
import { repeatNumberError, useRepeatState } from './repeatState.ts';
import { offeredTaskLists, taskEditorChanges, type TaskEditorValues } from './taskEditorChanges.ts';

export interface TaskEditorSeed {
  /** Present when editing; absent for create. */
  readonly existing?: TaskRecord | undefined;
  /** Default due day for creates ('YYYY-MM-DD') — usually the focused day. */
  readonly initialDate: string;
}

const listKeyOf = (accountId: string, listId: string) => `${accountId}:${listId}`;

/** Alarm offsets the Reminders form offers (minutes relative to the due time). */
export const REMINDER_ALARM_OPTIONS: ReadonlyArray<{ label: string; value: number | undefined }> = [
  { label: 'None', value: undefined },
  { label: 'At time', value: 0 },
  { label: '5 min before', value: -5 },
  { label: '15 min before', value: -15 },
  { label: '1 hour before', value: -60 },
  { label: '1 day before', value: -1440 },
];

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

/**
 * Shared editor state for the Task mode of both platforms' edit sheets —
 * the small sibling of useEventEditorModel. The selected list decides the
 * provider, and the provider decides the form: Google Tasks are title /
 * due day / notes with a list fixed after create; Apple Reminders add a
 * due time, priority, URL, an alarm, a repeat rule, and can move between
 * lists. Due date is required for both: with no task-list view in the
 * app, an undated task would simply be invisible.
 */
export const useTaskEditorModel = ({
  onClose,
  seed,
  taskLists,
}: {
  onClose: () => void;
  seed: TaskEditorSeed;
  taskLists: ReadonlyArray<TaskListInfo>;
}) => {
  const mutations = useBackendMutations();
  const existing = seed.existing;
  const [title, setTitle] = useState(existing?.title ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? seed.initialDate);
  const [listKey, setListKey] = useState(
    existing
      ? listKeyOf(existing.accountId, existing.listId)
      : taskLists[0]
        ? listKeyOf(taskLists[0].accountId, taskLists[0].id)
        : '',
  );
  // Reminders-only state. Kept even while a Google list is selected so a
  // flip between lists in create mode does not lose what was typed.
  const [timed, setTimed] = useState(existing?.dueTime !== undefined);
  const [dueTime, setDueTime] = useState(existing?.dueTime ?? '09:00');
  const [priority, setPriority] = useState<TaskPriority | undefined>(existing?.priority);
  const [url, setUrl] = useState(existing?.url ?? '');
  // The form edits the FIRST relative alert; any further alerts the user
  // set in Reminders.app ride along untouched.
  const [initialAlarms] = useState<ReadonlyArray<number>>(() => existing?.alarms ?? []);
  const [alarm, setAlarm] = useState<number | undefined>(initialAlarms[0]);
  const { toSpec: repeatSpec, ...repeatState } = useRepeatState(existing?.recurrence);
  // What the form opened with: Save sends only the fields that differ from
  // it (see taskEditorChanges) — captured once, not re-read from the row.
  const [initial] = useState<TaskEditorValues | undefined>(() =>
    existing
      ? {
          alarm: initialAlarms[0],
          dueDate: existing.dueDate ?? seed.initialDate,
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

  const offeredLists = offeredTaskLists(taskLists, existing);
  const selectedList = taskLists.find((list) => listKeyOf(list.accountId, list.id) === listKey);
  const provider: TaskProvider = existing?.provider ?? selectedList?.provider ?? 'google';
  /** Reminders can move between lists; Google Tasks cannot (needs tasks.move). */
  const canMoveList = provider === 'apple';
  const recurrenceUnsupported = existing?.recurrenceUnsupported === true;
  /** The task sits in a list EventKit will not let us write: the form is a viewer. */
  const readOnly =
    existing !== undefined &&
    taskLists.some(
      (list) =>
        list.readOnly === true &&
        list.accountId === existing.accountId &&
        list.id === existing.listId,
    );

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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      setError('A due date is required.');
      return;
    }
    if (provider === 'apple' && timed && !TIME_RE.test(dueTime)) {
      setError('The due time must be HH:MM.');
      return;
    }
    if (provider === 'apple' && url.trim() && !URL.canParse(url.trim())) {
      setError('The URL is not valid.');
      return;
    }
    if (provider === 'apple' && repeatState.repeat !== 'none') {
      const invalid =
        repeatNumberError(repeatState.repeatInterval, 'The repeat interval') ??
        (repeatState.repeatEnds === 'after'
          ? repeatNumberError(repeatState.repeatCount, 'The occurrence count')
          : undefined);
      if (invalid) {
        setError(invalid);
        return;
      }
    }
    try {
      if (existing && initial) {
        const changes = taskEditorChanges({
          current: {
            alarm,
            dueDate,
            dueTime: timed ? dueTime : undefined,
            listId: taskListId,
            notes: notes.trim(),
            priority,
            recurrence: repeatSpec(),
            title: title.trim(),
            url: url.trim(),
          },
          initial,
          initialAlarms,
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
        const spec = repeatSpec();
        await mutations.createTask({
          accountId,
          dueDate,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          taskListId,
          title: title.trim(),
          ...(provider === 'apple'
            ? {
                ...(alarm === undefined ? {} : { alarms: [alarm] }),
                ...(timed ? { dueTime } : {}),
                ...(priority === undefined ? {} : { priority }),
                ...(spec === undefined ? {} : { recurrence: spec }),
                ...(url.trim() ? { url: url.trim() } : {}),
              }
            : {}),
        });
      }
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  const remove = async () => {
    if (!existing || readOnly) {
      return;
    }
    try {
      await mutations.deleteTask({
        accountId: existing.accountId,
        taskId: existing.id,
        taskListId: existing.listId,
      });
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  return {
    alarm,
    canMoveList,
    dueDate,
    dueTime,
    error,
    existing,
    listKey,
    notes,
    priority,
    provider,
    readOnly,
    recurrenceUnsupported,
    remove,
    ...repeatState,
    save,
    setAlarm,
    setDueDate,
    setDueTime,
    setListKey,
    setNotes,
    setPriority,
    setTimed,
    setTitle,
    setUrl,
    taskLists: offeredLists,
    timed,
    title,
    url,
  };
};
