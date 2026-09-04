import type { TaskListInfo, TaskPriority, TaskProvider, TaskRecord } from '@calendar/core';
import { useState } from 'react';
import { useBackendMutations } from './hooks.ts';
import { useRepeatState } from './repeatState.ts';

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
  // set in Reminders.app ride along untouched, and `alarms` is only sent
  // when the alert actually changed (a full replace would wipe them).
  const initialAlarms = existing?.alarms ?? [];
  const [alarm, setAlarm] = useState<number | undefined>(initialAlarms[0]);
  const alarmChanged = alarm !== initialAlarms[0];
  const alarmsToWrite = (): ReadonlyArray<number> => [
    ...(alarm === undefined ? [] : [alarm]),
    ...initialAlarms.slice(1),
  ];
  const { toSpec: repeatSpec, ...repeatState } = useRepeatState(existing?.recurrence);
  const [error, setError] = useState<string | null>(null);

  // Editing: a reminder can only move within its own account (and a Google
  // task cannot move at all), so the picker never offers the other
  // provider's lists. Creating: every list, since the choice decides the
  // provider.
  const offeredLists = existing
    ? taskLists.filter((list) => list.accountId === existing.accountId)
    : taskLists;
  const selectedList = taskLists.find((list) => listKeyOf(list.accountId, list.id) === listKey);
  const provider: TaskProvider = existing?.provider ?? selectedList?.provider ?? 'google';
  /** Reminders can move between lists; Google Tasks cannot (needs tasks.move). */
  const canMoveList = provider === 'apple';
  const recurrenceUnsupported = existing?.recurrenceUnsupported === true;

  const save = async () => {
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
    try {
      if (existing) {
        await mutations.updateTask({
          accountId: existing.accountId,
          changes: {
            dueDate,
            notes: notes.trim(),
            title: title.trim(),
            ...(provider === 'apple'
              ? {
                  ...(alarmChanged
                    ? { alarms: alarmsToWrite().length === 0 ? null : alarmsToWrite() }
                    : {}),
                  dueTime: timed ? dueTime : null,
                  ...(taskListId !== existing.listId ? { moveToListId: taskListId } : {}),
                  priority: priority ?? null,
                  // Never overwrite a rule the form could not show.
                  ...(recurrenceUnsupported ? {} : { recurrence: repeatSpec() ?? null }),
                  url: url.trim() || null,
                }
              : {}),
          },
          taskId: existing.id,
          taskListId: existing.listId,
        });
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
    if (!existing) {
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
