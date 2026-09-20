import type { TaskRecord } from './types.ts';
import { snapMinutes } from './time/dragMath.ts';
import { Temporal } from './time/temporal.ts';

/** Timed reminders are points; this synthetic span only reserves overlap space. */
export const TIMED_TASK_LAYOUT_MINUTES = 30;

export const calendarTaskKey = (task: Pick<TaskRecord, 'accountId' | 'id' | 'listId'>): string =>
  `task:${task.accountId}:${task.listId}:${task.id}`;

/** An open task whose due day has passed (both dates are 'YYYY-MM-DD', so string order is date order). */
export const isOverdue = (task: Pick<TaskRecord, 'dueDate' | 'status'>, today: string): boolean =>
  task.status === 'needsAction' && task.dueDate !== undefined && task.dueDate < today;

/**
 * Splits the calendar's tasks into the all-day lane, the timed grid and —
 * given `today` — the overdue set: open tasks due before today, timed or
 * not, which the lanes draw on today instead of on their own past day.
 * The in-range and overdue queries overlap when a past due day is inside
 * the rendered strip, so tasks are de-duplicated by key first.
 */
export const partitionCalendarTasks = (
  tasks: ReadonlyArray<TaskRecord>,
  today?: string,
): {
  readonly allDay: Array<TaskRecord>;
  readonly overdue: Array<TaskRecord>;
  readonly timed: Array<TaskRecord>;
} => {
  const allDay: Array<TaskRecord> = [];
  const overdue: Array<TaskRecord> = [];
  const timed: Array<TaskRecord> = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.dueDate === undefined) {
      continue;
    }
    const key = calendarTaskKey(task);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (today !== undefined && isOverdue(task, today)) {
      overdue.push(task);
    } else if (task.dueTime === undefined) {
      allDay.push(task);
    } else {
      timed.push(task);
    }
  }
  overdue.sort(
    (a, b) =>
      a.dueDate!.localeCompare(b.dueDate!) ||
      (a.dueTime ?? '').localeCompare(b.dueTime ?? '') ||
      a.title.localeCompare(b.title),
  );
  return { allDay, overdue, timed };
};

const DAY_MINUTES = 24 * 60;

const minutesOf = (time: string): number => {
  const parsed = Temporal.PlainTime.from(time);
  return parsed.hour * 60 + parsed.minute;
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Projects a point-in-time reminder into the ordinary overlap layout. A
 * reminder's due date and time are wall-clock values (EventKit stores them
 * as date components), so this never goes through a time zone. Near
 * midnight the synthetic interval shifts upward so its compact block
 * remains wholly visible on the reminder's due day.
 */
export const timedTaskSlot = (
  task: Pick<TaskRecord, 'dueDate' | 'dueTime'>,
): { readonly endMinute: number; readonly startMinute: number } | undefined => {
  if (task.dueDate === undefined || task.dueTime === undefined) {
    return undefined;
  }
  const startMinute = Math.min(minutesOf(task.dueTime), DAY_MINUTES - TIMED_TASK_LAYOUT_MINUTES);
  return { endMinute: startMinute + TIMED_TASK_LAYOUT_MINUTES, startMinute };
};

/**
 * Move a timed reminder with the calendar's 15-minute drag rules. A time
 * move starts from where the block is drawn — not the stored time, which
 * differs near midnight — so the reminder lands where it was dropped. A
 * day-only move keeps the stored time.
 */
export const moveTimedTask = (
  task: Pick<TaskRecord, 'dueDate' | 'dueTime'>,
  deltaMinutes: number,
  deltaDays = 0,
): { readonly dueDate?: string; readonly dueTime?: string } | undefined => {
  const slot = timedTaskSlot(task);
  if (slot === undefined || task.dueDate === undefined || task.dueTime === undefined) {
    return undefined;
  }
  const minutes = snapMinutes(deltaMinutes);
  const from =
    minutes === 0
      ? Temporal.PlainTime.from(task.dueTime)
      : new Temporal.PlainTime(Math.floor(slot.startMinute / 60), slot.startMinute % 60);
  const moved = Temporal.PlainDate.from(task.dueDate)
    .toPlainDateTime(from)
    .add({ days: deltaDays, minutes });
  const dueDate = moved.toPlainDate().toString();
  const dueTime = `${pad2(moved.hour)}:${pad2(moved.minute)}`;
  if (dueDate === task.dueDate && dueTime === task.dueTime) {
    return undefined;
  }
  return {
    ...(dueDate === task.dueDate ? {} : { dueDate }),
    ...(dueTime === task.dueTime ? {} : { dueTime }),
  };
};

/** A drop from a chip drag: a day in the all-day lane, or a day and a minute in the grid. */
export type TaskDrop =
  | { readonly dueDate: string; readonly kind: 'allDay' }
  | { readonly dueDate: string; readonly kind: 'timed'; readonly minute: number };

export type TaskDropResult =
  | { readonly changes: { readonly dueDate?: string; readonly dueTime?: string | null } }
  /** The target needs a field this task's provider cannot hold — refuse visibly, never silently. */
  | { readonly unsupported: 'dueTime' };

/**
 * The changes a drop asks for, or undefined when it asks for nothing. A grid
 * drop gives the task that day and time; a lane drop gives it that day and
 * clears the time (also when an overdue timed reminder is dragged along the
 * lane it is drawn in). Google Tasks are date-only, so a grid drop on one is
 * reported as unsupported rather than turned into a day-only move.
 */
export const dropTaskChanges = (
  task: Pick<TaskRecord, 'dueDate' | 'dueTime' | 'provider'>,
  drop: TaskDrop,
): TaskDropResult | undefined => {
  if (drop.kind === 'timed') {
    if (task.provider === 'google') {
      return { unsupported: 'dueTime' };
    }
    const dueTime = `${pad2(Math.floor(drop.minute / 60))}:${pad2(drop.minute % 60)}`;
    const changes = {
      ...(drop.dueDate === task.dueDate ? {} : { dueDate: drop.dueDate }),
      ...(dueTime === task.dueTime ? {} : { dueTime }),
    };
    return Object.keys(changes).length === 0 ? undefined : { changes };
  }
  const changes = {
    ...(drop.dueDate === task.dueDate ? {} : { dueDate: drop.dueDate }),
    ...(task.dueTime === undefined ? {} : { dueTime: null }),
  };
  return Object.keys(changes).length === 0 ? undefined : { changes };
};
