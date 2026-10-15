import { isOverdue, partitionCalendarTasks } from './taskTiming.ts';
import { toZonedDateTime } from './time/convert.ts';
import type { TaskRecord } from './types.ts';

/** The day a task was completed on, in the zone. */
const completionDay = (task: TaskRecord, timeZone: string): string =>
  toZonedDateTime(task.completedAt ?? task.updatedAt, timeZone)
    .toPlainDate()
    .toString();

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
    // By the day it was done, not the day it was due: the grid places an
    // early completion on its due day, but "done today" is about today.
    completedToday: dated
      .filter((task) => task.status === 'completed' && completionDay(task, timeZone) === today)
      .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt)),
    noDate: undated,
    overdue,
    today: open.filter((task) => task.dueDate === today).sort(byDueThenTitle),
    upcoming: open
      .filter((task) => task.dueDate !== undefined && task.dueDate > today)
      .sort(byDueThenTitle),
  };
};

/** A row of a task section and the subtasks drawn indented under it. */
export interface TaskTreeNode {
  /** In Google's order among siblings (`position`); empty for most rows. */
  readonly subtasks: ReadonlyArray<TaskRecord>;
  readonly task: TaskRecord;
}

/** A task in its list and account: Google ids are unique within a list. `id` names another task there. */
const keyOf = (task: TaskRecord, id = task.id): string => `${task.accountId}:${task.listId}:${id}`;

/** The key of the task's parent; a Google subtask's parent is in its own list. */
const parentKeyOf = (task: TaskRecord): string | undefined =>
  task.parentId === undefined ? undefined : keyOf(task, task.parentId);

/** Positions compare code unit by code unit, as Google and SQLite order them — not as text to read. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Google's sibling order; a subtask without a position yet (not pulled since it was made) goes last. */
export const compareTaskPosition = (a: TaskRecord, b: TaskRecord): number =>
  Number(a.position === undefined) - Number(b.position === undefined) ||
  byCodeUnit(a.position ?? '', b.position ?? '') ||
  a.title.localeCompare(b.title) ||
  a.id.localeCompare(b.id);

/**
 * Nests one section's tasks (an inbox group, after any list filter) the
 * way Google Tasks draws them: a subtask goes under its parent when the
 * parent is a row of the same section, siblings in Google's `position`
 * order. A subtask whose parent is not there — due in another section,
 * completed, or filtered out — stays a row of its own where it is, so a
 * section never draws a task it does not hold and a late subtask is never
 * hidden under a parent from another day. Google nests one level deep:
 * a task whose parent is itself drawn nested stays at the top, which also
 * breaks a cycle. Top-level rows keep the section's order. Reminders have
 * no parents and pass through unchanged.
 */
export const nestSubtasks = (tasks: ReadonlyArray<TaskRecord>): ReadonlyArray<TaskTreeNode> => {
  const present = new Set(tasks.map((task) => keyOf(task)));
  const hasParentHere = (task: TaskRecord): boolean => present.has(parentKeyOf(task) ?? '');
  // Who may hold subtasks: a row drawn at the top, i.e. without its parent here.
  const holders = new Set(tasks.filter((task) => !hasParentHere(task)).map((task) => keyOf(task)));
  const children = new Map<string, Array<TaskRecord>>();
  for (const task of tasks) {
    const parent = parentKeyOf(task);
    if (parent !== undefined && holders.has(parent)) {
      const siblings = children.get(parent);
      if (siblings) {
        siblings.push(task);
      } else {
        children.set(parent, [task]);
      }
    }
  }
  const nested = new Set([...children.values()].flat().map((task) => keyOf(task)));
  return tasks
    .filter((task) => !nested.has(keyOf(task)))
    .map((task) => ({
      subtasks: (children.get(keyOf(task)) ?? []).sort(compareTaskPosition),
      task,
    }));
};
