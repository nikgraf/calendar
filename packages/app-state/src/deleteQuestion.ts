import type { RecurringScope } from '@calendar/core';

/**
 * What a delete asks before it runs, naming what goes. A delete used to be
 * one tap with nothing to undo it: "All events" removed a whole series,
 * and an Apple delete is gone from EventKit at once. `scope` is given for
 * an occurrence of a series.
 */
export const deleteQuestion = (title: string, scope?: RecurringScope): string => {
  const name = `“${title.trim()}”`;
  switch (scope) {
    case 'instance':
      return `Delete this occurrence of ${name}?`;
    case 'following':
      return `Delete ${name} from this occurrence on?`;
    case 'series':
      return `Delete every occurrence of ${name}?`;
    case undefined:
      return `Delete ${name}?`;
  }
};

/**
 * A task's delete question: Google deletes a parent's subtasks with it,
 * so they are named (`subtasks` is the backend's count, `previewDeleteTask`).
 */
export const deleteTaskQuestion = (title: string, subtasks: number): string => {
  if (subtasks === 0) {
    return deleteQuestion(title);
  }
  const name = `“${title.trim()}”`;
  return subtasks === 1
    ? `Delete ${name} and its subtask?`
    : `Delete ${name} and its ${String(subtasks)} subtasks?`;
};
