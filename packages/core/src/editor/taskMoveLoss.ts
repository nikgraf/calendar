import { Schema } from 'effect';
import type { TaskRecord } from '../types.ts';
import { joinList, type MoveRoute, plural } from './moveLoss.ts';

/**
 * What moving a task to another list would drop. Google Tasks hold a
 * title, notes, a due day and completion; everything else on a reminder
 * (its time, alerts, priority, repeat rule and URL) has no home there.
 * A move between two Reminders lists keeps the reminder as it is, and a
 * Google task carries nothing Reminders cannot store (its web link points
 * at the task being deleted, so it is not a loss).
 */
export const TaskMoveLoss = Schema.Struct({
  /** Alerts (relative alarms) that will not follow the task. */
  alarms: Schema.Number,
  dueTime: Schema.Boolean,
  priority: Schema.Boolean,
  /** A repeat rule, expressible by the app or not. */
  recurrence: Schema.Boolean,
  url: Schema.Boolean,
});
export type TaskMoveLoss = typeof TaskMoveLoss.Type;

const NO_LOSS: TaskMoveLoss = {
  alarms: 0,
  dueTime: false,
  priority: false,
  recurrence: false,
  url: false,
};

export const taskMoveLoss = (
  task: Pick<
    TaskRecord,
    'alarms' | 'dueTime' | 'priority' | 'recurrence' | 'recurrenceUnsupported' | 'url'
  >,
  route: MoveRoute,
): TaskMoveLoss =>
  route.source === 'apple' && route.target === 'google'
    ? {
        alarms: task.alarms?.length ?? 0,
        dueTime: task.dueTime !== undefined,
        priority: task.priority !== undefined,
        recurrence: task.recurrence !== undefined || task.recurrenceUnsupported === true,
        url: task.url !== undefined && task.url !== '',
      }
    : NO_LOSS;

export const isTaskMoveLossy = (loss: TaskMoveLoss): boolean =>
  loss.alarms > 0 || loss.dueTime || loss.priority || loss.recurrence || loss.url;

/** One sentence for the move confirmation, or null when nothing is lost. */
export const taskMoveLossSummary = (loss: TaskMoveLoss): string | null => {
  const items: Array<string> = [];
  if (loss.dueTime) {
    items.push('the due time');
  }
  if (loss.alarms > 0) {
    items.push(plural(loss.alarms, 'alert', 'alerts'));
  }
  if (loss.priority) {
    items.push('the priority');
  }
  if (loss.recurrence) {
    items.push('the repeat rule');
  }
  if (loss.url) {
    items.push('the URL');
  }
  return items.length === 0 ? null : `Moving this task to Google Tasks drops ${joinList(items)}.`;
};
