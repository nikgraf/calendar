import type { TaskRecord } from './types.ts';

/** '!' / '!!' / '!!!' the way the Reminders app marks priority; '' for none. */
export const priorityMarker = (priority: TaskRecord['priority']): string => {
  switch (priority) {
    case 'high':
      return '!!!';
    case 'medium':
      return '!!';
    case 'low':
      return '!';
    default:
      return '';
  }
};

/**
 * Chip text for the all-day task lane: a timed reminder leads with its
 * time, a prioritised one with its marker — both platforms render this
 * string so the lane reads the same everywhere.
 */
export const taskChipLabel = (task: Pick<TaskRecord, 'dueTime' | 'priority' | 'title'>): string => {
  const parts: Array<string> = [];
  if (task.dueTime !== undefined) {
    parts.push(task.dueTime);
  }
  const marker = priorityMarker(task.priority);
  if (marker) {
    parts.push(marker);
  }
  parts.push(task.title);
  return parts.join(' ');
};
