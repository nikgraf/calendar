import type { TaskListInfo, TaskRecord } from '@calendar/core';
import { useState } from 'react';
import { useBackendMutations } from './hooks.ts';

export interface TaskEditorSeed {
  /** Present when editing; absent for create. */
  readonly existing?: TaskRecord | undefined;
  /** Default due day for creates ('YYYY-MM-DD') — usually the focused day. */
  readonly initialDate: string;
}

const listKeyOf = (accountId: string, listId: string) => `${accountId}:${listId}`;

/**
 * Shared editor state for the Task mode of both platforms' edit sheets —
 * the small sibling of useEventEditorModel. Due date is required: with no
 * task-list view in the app, an undated task would simply be invisible.
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
  const [error, setError] = useState<string | null>(null);

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
    try {
      if (existing) {
        await mutations.updateTask({
          accountId: existing.accountId,
          changes: {
            dueDate,
            notes: notes.trim(),
            title: title.trim(),
          },
          taskId: existing.id,
          taskListId: existing.listId,
        });
      } else {
        await mutations.createTask({
          accountId,
          dueDate,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          taskListId,
          title: title.trim(),
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
    dueDate,
    error,
    existing,
    listKey,
    notes,
    remove,
    save,
    setDueDate,
    setListKey,
    setNotes,
    setTitle,
    // The list is fixed after create — moving needs tasks.move.
    taskLists,
    title,
  };
};
