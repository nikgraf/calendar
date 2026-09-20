import { Temporal } from './time/temporal.ts';
import type { TaskRecord } from './types.ts';

/** Text-presentation warning sign (U+FE0E keeps Apple platforms from drawing the color emoji). */
export const OVERDUE_MARKER = '\u26a0\ufe0e';
/** Clockwise open-circle arrow: plain text presentation on every platform. */
export const REPEAT_MARKER = '\u21bb';

/** Reminders with a repeat rule, expressible or not; Google tasks never carry one. */
export const taskRepeats = (
  task: Pick<TaskRecord, 'recurrence' | 'recurrenceUnsupported'>,
): boolean => task.recurrence !== undefined || task.recurrenceUnsupported === true;

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

/** "Overdue · due Sep 17" (with the year once it differs from today's). */
export const overdueLabel = (task: Pick<TaskRecord, 'dueDate'>, today: string): string => {
  if (task.dueDate === undefined) {
    return 'Overdue';
  }
  const due = Temporal.PlainDate.from(task.dueDate);
  const sameYear = due.year === Temporal.PlainDate.from(today).year;
  return `Overdue · due ${due.toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })}`;
};

/**
 * Task text for all-day lanes and month summaries. Month summaries retain a
 * timed reminder's time prefix; timed-grid blocks use only the priority and
 * title because their vertical position already communicates the time. An
 * overdue chip leads with the warning marker and drops the time: it sits on
 * today, where a past day's clock time would only mislead. A repeating
 * reminder ends with the repeat marker.
 */
export const taskChipLabel = (
  task: Pick<TaskRecord, 'dueTime' | 'priority' | 'title'>,
  options: { readonly overdue?: boolean; readonly repeats?: boolean } = {},
): string => {
  const parts: Array<string> = [];
  if (options.overdue) {
    parts.push(OVERDUE_MARKER);
  } else if (task.dueTime !== undefined) {
    parts.push(task.dueTime);
  }
  const marker = priorityMarker(task.priority);
  if (marker) {
    parts.push(marker);
  }
  parts.push(task.title);
  if (options.repeats) {
    parts.push(REPEAT_MARKER);
  }
  return parts.join(' ');
};
