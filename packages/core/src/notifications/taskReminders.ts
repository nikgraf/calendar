import { formatClockTime } from '../format.ts';
import { toZonedDateTime } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';
import { isAppleRemindersAccount, type TaskListInfo, type TaskRecord } from '../types.ts';
import { type PlannedNotification, taskNotificationTarget } from './planned.ts';
import type { TaskNotificationSettings } from './settings.ts';
import { timeOfDayToUtc } from './timeOfDay.ts';

/** A Google task created here and not yet pushed: its id changes when the push lands. */
const isTempTaskId = (id: string): boolean => id.startsWith('local-');

/**
 * Every notification due for the open tasks whose due day falls in
 * `[fromDate, untilDate]` (inclusive, 'YYYY-MM-DD'): a task with a time
 * of its own at that time, any other at `settings.time` on its due day,
 * both on the device's clock — a task's day and time already are, except
 * a reminder with an instant of its own (`dueUtc`), whose due day here is
 * that instant's: its stored day was written in the zone the device was
 * in when the row was last read, and the mirror re-reads only changed
 * rows.
 * Skipped: completed tasks, tasks without a due day, tasks on a list not
 * in `lists` (the visible ones), Apple Reminders unless
 * `includeAppleReminders`, and a Google task still under its temporary
 * id (the push hands back the real one within seconds; a desktop would
 * otherwise fire twice). Nothing when the setting is off. One
 * notification per task and due day — the key names those, not the
 * list, which a move changes — never again: an overdue task does not
 * repeat. A missed one stays worth showing until midnight after the
 * due day. No `dismissAt`: a task is done when it is checked off, which
 * the scheduler reads from the stored row. A task whose dates this
 * engine cannot read goes without a notification, never the whole pass.
 */
export const planTaskReminders = (
  tasks: ReadonlyArray<TaskRecord>,
  settings: TaskNotificationSettings,
  options: {
    readonly fromDate: string;
    /** The visible lists; a task on another list is skipped, and with several the body names the task's. */
    readonly lists: ReadonlyArray<TaskListInfo>;
    readonly timeZone: string;
    readonly untilDate: string;
  },
): ReadonlyArray<PlannedNotification> => {
  if (!settings.enabled) {
    return [];
  }
  const lists = new Map(options.lists.map((list) => [`${list.accountId}:${list.id}`, list]));
  const nameLists = options.lists.length > 1;
  const out: Array<PlannedNotification> = [];
  for (const task of tasks) {
    const { dueDate: storedDay } = task;
    if (task.status !== 'needsAction' || storedDay === undefined || isTempTaskId(task.id)) {
      continue;
    }
    if (isAppleRemindersAccount({ id: task.accountId }) && !settings.includeAppleReminders) {
      continue;
    }
    const list = lists.get(`${task.accountId}:${task.listId}`);
    if (!list) {
      continue;
    }
    try {
      const dueDate =
        task.dueUtc === undefined
          ? storedDay
          : toZonedDateTime(task.dueUtc, options.timeZone).toPlainDate().toString();
      if (dueDate < options.fromDate || dueDate > options.untilDate) {
        continue;
      }
      const timed = task.dueUtc !== undefined || task.dueTime !== undefined;
      const fireAt =
        task.dueUtc ?? timeOfDayToUtc(dueDate, task.dueTime ?? settings.time, options.timeZone);
      const expiresAt = Temporal.PlainDate.from(dueDate)
        .add({ days: 1 })
        .toZonedDateTime({ timeZone: options.timeZone }).epochMilliseconds;
      const parts = [
        timed ? `Due today · ${formatClockTime(fireAt, options.timeZone)}` : 'Due today',
      ];
      if (nameLists) {
        parts.push(list.title);
      }
      out.push({
        body: parts.join(' · '),
        expiresAt,
        fireAt,
        key: `task:${task.accountId}/${task.id}:${dueDate}`,
        // The day the row says, which the rule compares to the row again.
        target: taskNotificationTarget(task, storedDay),
        title: task.title,
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key));
};
