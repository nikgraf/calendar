import { TaskListInfo, type TaskPriority, TaskRecord } from '@calendar/core';
import type { ReminderJson, ReminderListJson, ReminderWrite } from './protocol.ts';

/**
 * EventKit priority is 0…9; the Reminders app shows three buckets. We keep
 * the buckets (the only thing a user can pick) and write back the values
 * the Reminders app itself uses.
 */
export const priorityFromEventKit = (raw: number): TaskPriority | undefined => {
  if (raw <= 0) {
    return undefined;
  }
  if (raw <= 4) {
    return 'high';
  }
  return raw === 5 ? 'medium' : 'low';
};

export const priorityToEventKit = (priority: TaskPriority | undefined | null): number => {
  switch (priority) {
    case 'high':
      return 1;
    case 'medium':
      return 5;
    case 'low':
      return 9;
    default:
      return 0;
  }
};

export const mapReminderList = (list: ReminderListJson, accountId: string): TaskListInfo =>
  new TaskListInfo({
    accountId,
    ...(list.colorHex === undefined ? {} : { colorHex: list.colorHex }),
    id: list.id,
    // Pull-side default; upsertLists preserves an existing local toggle.
    isVisible: true,
    provider: 'apple',
    // EventKit refuses saves into such a list; keep it out of the pickers.
    ...(list.allowsModifications ? {} : { readOnly: true }),
    title: list.title,
  });

export const mapReminder = (reminder: ReminderJson, accountId: string): TaskRecord => {
  const priority = priorityFromEventKit(reminder.priority);
  const recurrence = reminder.recurrence;
  return new TaskRecord({
    accountId,
    ...(reminder.alarms.length > 0 ? { alarms: reminder.alarms } : {}),
    ...(reminder.completedAt === undefined ? {} : { completedAt: reminder.completedAt }),
    ...(reminder.dueDate === undefined ? {} : { dueDate: reminder.dueDate }),
    ...(reminder.dueTime === undefined ? {} : { dueTime: reminder.dueTime }),
    id: reminder.id,
    listId: reminder.listId,
    ...(reminder.notes === undefined || reminder.notes === '' ? {} : { notes: reminder.notes }),
    ...(priority === undefined ? {} : { priority }),
    provider: 'apple',
    ...(recurrence === undefined
      ? {}
      : 'unsupported' in recurrence
        ? { recurrenceUnsupported: true as const }
        : {
            recurrence: {
              ...(recurrence.count === undefined ? {} : { count: recurrence.count }),
              freq: recurrence.freq,
              interval: recurrence.interval,
              ...(recurrence.untilDate === undefined ? {} : { untilDate: recurrence.untilDate }),
            },
          }),
    status: reminder.completed ? 'completed' : 'needsAction',
    title: reminder.title === '' ? '(untitled)' : reminder.title,
    updatedAt: reminder.updatedAt,
    ...(reminder.url === undefined ? {} : { url: reminder.url }),
  });
};

/** The task-side write shape (rpc `changes` / createTask fields) before it becomes EventKit JSON. */
export interface TaskWriteFields {
  readonly alarms?: ReadonlyArray<number> | null | undefined;
  readonly dueDate?: string | null | undefined;
  readonly dueTime?: string | null | undefined;
  readonly notes?: string | null | undefined;
  readonly priority?: TaskPriority | null | undefined;
  readonly recurrence?: TaskRecord['recurrence'] | null | undefined;
  readonly title?: string | undefined;
  readonly url?: string | null | undefined;
}

/**
 * `undefined` = unchanged, `null` = clear (both survive JSON: null is
 * encoded, undefined keys are dropped). Priority buckets become EK ints.
 */
export const toReminderWrite = (fields: TaskWriteFields): ReminderWrite => ({
  ...(fields.alarms === undefined ? {} : { alarms: fields.alarms }),
  ...(fields.dueDate === undefined ? {} : { dueDate: fields.dueDate }),
  ...(fields.dueTime === undefined ? {} : { dueTime: fields.dueTime }),
  ...(fields.notes === undefined ? {} : { notes: fields.notes === '' ? null : fields.notes }),
  ...(fields.priority === undefined ? {} : { priority: priorityToEventKit(fields.priority) }),
  ...(fields.recurrence === undefined ? {} : { recurrence: fields.recurrence }),
  ...(fields.title === undefined ? {} : { title: fields.title }),
  ...(fields.url === undefined ? {} : { url: fields.url === '' ? null : fields.url }),
});
