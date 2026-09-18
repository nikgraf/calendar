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
 * Task text for all-day lanes and month summaries. Month summaries retain a
 * timed reminder's time prefix; timed-grid blocks use only the priority and
 * title because their vertical position already communicates the time.
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
