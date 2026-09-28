import { Schema } from 'effect';
import { taskRecurrenceFromLines } from '../recurrence/taskRecurrence.ts';
import {
  type EventReminders,
  type TaskPriority,
  type TaskProvider,
  type TaskRecord,
  TaskRecurrence,
} from '../types.ts';
import { joinList, plural } from './moveLoss.ts';

/**
 * What turning an event into a task, or a task into an event, would drop.
 * Only fields that are actually set count, so a plain "title, day and
 * time" converts without a question. The end time is never a loss (a
 * task has no duration), nor are reminders the calendar's defaults supply,
 * nor links: a meeting link becomes the reminder's URL or is appended to
 * a Google task's notes, and a reminder's URL becomes an Apple event's
 * URL or is appended to a Google event's description.
 */
export const EventToTaskLoss = Schema.Struct({
  /** Guests (rooms excluded); tasks have none. */
  attendees: Schema.Number,
  /** A timed event heading for Google Tasks, which are date-only. */
  dueTime: Schema.Boolean,
  location: Schema.Boolean,
  /** Occurrences edited or cancelled on their own; the series converts as its rule. */
  modifiedOccurrences: Schema.Number,
  /** A rule Google Tasks cannot repeat at all, or a Reminder cannot express. */
  recurrence: Schema.Boolean,
  /** Explicit reminders that cannot become alarms: every one on Google Tasks, email ones on Reminders. */
  reminders: Schema.Number,
});
export type EventToTaskLoss = typeof EventToTaskLoss.Type;

/** The event as a record or as the editor's fields: both fit. */
export interface EventConvertSource {
  readonly attendees?:
    | ReadonlyArray<{
        readonly email: string;
        readonly isOrganizer?: boolean | undefined;
        readonly isResource?: boolean | undefined;
        readonly isSelf?: boolean | undefined;
      }>
    | undefined;
  readonly isAllDay: boolean;
  readonly location?: string | undefined;
  /** RFC 5545 lines. */
  readonly recurrence?: ReadonlyArray<string> | undefined;
  readonly reminders?: EventReminders | undefined;
  readonly startTimeZone?: string | undefined;
}

/**
 * The preview of an event → task conversion: what it drops, and the
 * series' rule as a reminder can hold it (absent when there is none or
 * it cannot be expressed). The rule rides along because the editor only
 * has the occurrence it was opened from, never the master's lines.
 */
export const EventToTaskPreview = Schema.Struct({
  carriedRecurrence: Schema.optional(TaskRecurrence),
  loss: EventToTaskLoss,
});
export type EventToTaskPreview = typeof EventToTaskPreview.Type;

export const eventToTaskLoss = (
  source: EventConvertSource,
  target: TaskProvider,
  modifiedOccurrences: number,
): EventToTaskLoss => ({
  attendees: (source.attendees ?? []).filter(
    (attendee) => !attendee.isResource && !attendee.isOrganizer && !attendee.isSelf,
  ).length,
  dueTime: !source.isAllDay && target === 'google',
  location: (source.location ?? '').trim() !== '',
  modifiedOccurrences,
  recurrence:
    source.recurrence !== undefined &&
    source.recurrence.length > 0 &&
    (target === 'google' ||
      taskRecurrenceFromLines(source.recurrence, {
        isAllDay: source.isAllDay,
        timeZone: source.startTimeZone ?? 'UTC',
      }) === undefined),
  // Reminders the calendar defaults supply are the calendar's, not the event's.
  reminders:
    source.reminders && !source.reminders.useDefault
      ? source.reminders.overrides.filter(
          (override) => target === 'google' || override.method === 'email',
        ).length
      : 0,
});

export const isEventToTaskLossy = (loss: EventToTaskLoss): boolean =>
  loss.attendees > 0 ||
  loss.dueTime ||
  loss.location ||
  loss.modifiedOccurrences > 0 ||
  loss.recurrence ||
  loss.reminders > 0;

/**
 * One sentence for the confirmation, or null when nothing is lost. `verb`
 * names the action ("Converting this event to a reminder", "Switching to
 * a task") so the create-mode flip and the Save-time conversion read right.
 */
export const eventToTaskLossSummary = (loss: EventToTaskLoss, verb: string): string | null => {
  const items: Array<string> = [];
  if (loss.attendees > 0) {
    items.push(plural(loss.attendees, 'guest', 'guests'));
  }
  if (loss.dueTime) {
    items.push('the time');
  }
  if (loss.location) {
    items.push('the location');
  }
  if (loss.reminders > 0) {
    items.push(plural(loss.reminders, 'notification', 'notifications'));
  }
  if (loss.recurrence) {
    items.push('the repeat rule');
  }
  if (loss.modifiedOccurrences > 0) {
    items.push(plural(loss.modifiedOccurrences, 'modified occurrence', 'modified occurrences'));
  }
  return items.length === 0 ? null : `${verb} drops ${joinList(items)}.`;
};

export const TaskToEventLoss = Schema.Struct({
  /** Alerts after the due time; event notifications only fire before the start. */
  alarmsAfterDue: Schema.Number,
  completed: Schema.Boolean,
  priority: Schema.Boolean,
  /** A repeat rule the app cannot express (it is never carried). */
  recurrence: Schema.Boolean,
});
export type TaskToEventLoss = typeof TaskToEventLoss.Type;

export interface TaskConvertSource {
  readonly alarms?: ReadonlyArray<number> | undefined;
  readonly priority?: TaskPriority | undefined;
  readonly recurrenceUnsupported?: boolean | undefined;
  readonly status?: TaskRecord['status'] | undefined;
}

export const taskToEventLoss = (source: TaskConvertSource): TaskToEventLoss => ({
  alarmsAfterDue: (source.alarms ?? []).filter((offset) => offset > 0).length,
  completed: source.status === 'completed',
  priority: source.priority !== undefined,
  recurrence: source.recurrenceUnsupported === true,
});

export const isTaskToEventLossy = (loss: TaskToEventLoss): boolean =>
  loss.alarmsAfterDue > 0 || loss.completed || loss.priority || loss.recurrence;

/** One sentence for the confirmation, or null when nothing is lost (see eventToTaskLossSummary). */
export const taskToEventLossSummary = (loss: TaskToEventLoss, verb: string): string | null => {
  const items: Array<string> = [];
  if (loss.priority) {
    items.push('the priority');
  }
  if (loss.alarmsAfterDue > 0) {
    items.push(
      plural(loss.alarmsAfterDue, 'alert after the due time', 'alerts after the due time'),
    );
  }
  if (loss.recurrence) {
    items.push('the repeat rule');
  }
  if (loss.completed) {
    items.push('the completed status');
  }
  return items.length === 0 ? null : `${verb} drops ${joinList(items)}.`;
};
