import { Schema } from 'effect';
import type { TaskRecord } from '../types.ts';
import { joinList, type MoveRoute, plural } from './moveLoss.ts';

/**
 * What moving a task to another list would drop. Google Tasks hold a
 * title, notes, a due day and completion; everything else on a reminder
 * (its time, alerts, priority, repeat rule and URL) has no home there.
 * A move between two Reminders lists keeps the reminder as it is, and a
 * Google task carries nothing Reminders cannot store (its web link points
 * at the task being deleted, so it is not a loss) — except its place in
 * a hierarchy: Google keeps a subtask's parent only within its list, and
 * Reminders has no subtasks at all.
 */
export const TaskMoveLoss = Schema.Struct({
  /** Alerts (relative alarms) that will not follow the task. */
  alarms: Schema.Number,
  dueTime: Schema.Boolean,
  /** A subtask: in the new list it is a task of its own (Google moves it that way too). */
  leavesParent: Schema.Boolean,
  priority: Schema.Boolean,
  /** A repeat rule, expressible by the app or not. */
  recurrence: Schema.Boolean,
  /** Subtasks that come along as tasks of their own: Reminders cannot nest them. */
  subtasksUnnested: Schema.Number,
  url: Schema.Boolean,
});
export type TaskMoveLoss = typeof TaskMoveLoss.Type;

/**
 * `subtasks`: how many subtasks the task has (they move with it — nested
 * under it again on Google, as tasks of their own in Reminders).
 */
export const taskMoveLoss = (
  task: Pick<
    TaskRecord,
    'alarms' | 'dueTime' | 'parentId' | 'priority' | 'recurrence' | 'recurrenceUnsupported' | 'url'
  >,
  route: MoveRoute,
  subtasks = 0,
): TaskMoveLoss => {
  const intoGoogle = route.source === 'apple' && route.target === 'google';
  return {
    alarms: intoGoogle ? (task.alarms?.length ?? 0) : 0,
    dueTime: intoGoogle && task.dueTime !== undefined,
    leavesParent: route.source === 'google' && task.parentId !== undefined,
    priority: intoGoogle && task.priority !== undefined,
    recurrence:
      intoGoogle && (task.recurrence !== undefined || task.recurrenceUnsupported === true),
    subtasksUnnested: route.source === 'google' && route.target === 'apple' ? subtasks : 0,
    url: intoGoogle && task.url !== undefined && task.url !== '',
  };
};

export const isTaskMoveLossy = (loss: TaskMoveLoss): boolean =>
  loss.alarms > 0 ||
  loss.dueTime ||
  loss.leavesParent ||
  loss.priority ||
  loss.recurrence ||
  loss.subtasksUnnested > 0 ||
  loss.url;

/**
 * The confirmation's words, or null when nothing is lost. `verb` names
 * the action: a move on Save by default, or the create-mode switch from
 * a reminder to a task ("Switching to a task").
 */
export const taskMoveLossSummary = (
  loss: TaskMoveLoss,
  verb = 'Moving this task to Google Tasks',
): string | null => {
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
  const sentences: Array<string> = [];
  if (items.length > 0) {
    sentences.push(`${verb} drops ${joinList(items)}.`);
  }
  if (loss.leavesParent) {
    sentences.push('It is a subtask: in the new list it becomes a task of its own.');
  }
  if (loss.subtasksUnnested > 0) {
    sentences.push(
      loss.subtasksUnnested === 1
        ? 'Its subtask comes along as a reminder of its own.'
        : `Its ${String(loss.subtasksUnnested)} subtasks come along as reminders of their own.`,
    );
  }
  return sentences.length === 0 ? null : sentences.join(' ');
};
