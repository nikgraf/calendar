import type { TaskFold } from './taskTiming.ts';
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

/** "due Sep 17" (with the year once it differs from today's). */
export const dueDayLabel = (dueDate: string, today: string): string => {
  const due = Temporal.PlainDate.from(dueDate);
  const sameYear = due.year === Temporal.PlainDate.from(today).year;
  return `due ${due.toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })}`;
};

/** "Overdue · due Sep 17" (with the year once it differs from today's). */
export const overdueLabel = (task: Pick<TaskRecord, 'dueDate'>, today: string): string =>
  task.dueDate === undefined ? 'Overdue' : `Overdue · ${dueDayLabel(task.dueDate, today)}`;

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

/**
 * A fold chip's text in the all-day lane: "⚠ 12 overdue", "11 no date".
 * The count leads, so a week-narrow column still shows it when the rest
 * is cut.
 */
export const taskFoldLabel = (fold: TaskFold, count: number): string =>
  fold === 'overdue' ? `${OVERDUE_MARKER} ${String(count)} overdue` : `${String(count)} no date`;

/** A fold's list heading, as the task inbox names the same section. */
export const taskFoldTitle = (fold: TaskFold): string =>
  fold === 'overdue' ? 'Overdue' : 'No date';

/** What a fold chip holds, spelled out for VoiceOver and the desktop's screen readers. */
export const taskFoldDescription = (fold: TaskFold, count: number): string => {
  const tasks = count === 1 ? 'task' : 'tasks';
  return fold === 'overdue'
    ? `${String(count)} overdue ${tasks}`
    : `${String(count)} ${tasks} with no date`;
};
