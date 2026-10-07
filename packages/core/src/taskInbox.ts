import { isOverdue, partitionCalendarTasks, taskCalendarDate } from './taskTiming.ts';
import type { TaskRecord } from './types.ts';

/** The task inbox's groups, in the order the rail shows them. */
export interface TaskInbox {
  /** Done today (on their due day or late), newest first. */
  readonly completedToday: ReadonlyArray<TaskRecord>;
  readonly noDate: ReadonlyArray<TaskRecord>;
  readonly overdue: ReadonlyArray<TaskRecord>;
  readonly today: ReadonlyArray<TaskRecord>;
  /** Open, due after today, soonest first. */
  readonly upcoming: ReadonlyArray<TaskRecord>;
}

const byDueThenTitle = (a: TaskRecord, b: TaskRecord): number =>
  (a.dueDate ?? '').localeCompare(b.dueDate ?? '') ||
  (a.dueTime ?? '').localeCompare(b.dueTime ?? '') ||
  a.title.localeCompare(b.title);

/**
 * Groups the tasks the calendar reads (a window's plus the overdue ones)
 * for the inbox: what is late, what is due today, what has no day, what
 * comes later, and what was finished today. Built on the same placement
 * as the grid (`partitionCalendarTasks`), so a task is never in two
 * places at once; the two queries may repeat a task and that is dropped
 * there.
 */
export const groupTaskInbox = (
  tasks: ReadonlyArray<TaskRecord>,
  today: string,
  timeZone: string,
): TaskInbox => {
  const { allDay, overdue, timed, undated } = partitionCalendarTasks(tasks, today, timeZone);
  const dated = [...allDay, ...timed];
  const open = dated.filter((task) => task.status === 'needsAction' && !isOverdue(task, today));
  return {
    completedToday: dated
      .filter(
        (task) => task.status === 'completed' && taskCalendarDate(task, today, timeZone) === today,
      )
      .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt)),
    noDate: undated,
    overdue,
    today: open.filter((task) => task.dueDate === today).sort(byDueThenTitle),
    upcoming: open
      .filter((task) => task.dueDate !== undefined && task.dueDate > today)
      .sort(byDueThenTitle),
  };
};
