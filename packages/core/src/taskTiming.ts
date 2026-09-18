import type { TaskRecord } from './types.ts';
import { snapMinutes } from './time/dragMath.ts';
import { Temporal } from './time/temporal.ts';

/** Timed reminders are points; this synthetic span only reserves overlap space. */
export const TIMED_TASK_LAYOUT_MINUTES = 30;

export const calendarTaskKey = (task: Pick<TaskRecord, 'accountId' | 'id' | 'listId'>): string =>
  `task:${task.accountId}:${task.listId}:${task.id}`;

export const partitionCalendarTasks = (
  tasks: ReadonlyArray<TaskRecord>,
): { readonly allDay: Array<TaskRecord>; readonly timed: Array<TaskRecord> } => {
  const allDay: Array<TaskRecord> = [];
  const timed: Array<TaskRecord> = [];
  for (const task of tasks) {
    if (task.dueDate === undefined) {
      continue;
    }
    if (task.dueTime === undefined) {
      allDay.push(task);
    } else {
      timed.push(task);
    }
  }
  return { allDay, timed };
};

const taskDateTime = (
  task: Pick<TaskRecord, 'dueDate' | 'dueTime'>,
  timeZone: string,
): Temporal.ZonedDateTime | undefined => {
  if (task.dueDate === undefined || task.dueTime === undefined) {
    return undefined;
  }
  return Temporal.PlainDate.from(task.dueDate)
    .toPlainDateTime(Temporal.PlainTime.from(task.dueTime))
    .toZonedDateTime(timeZone);
};

/**
 * Projects a point-in-time reminder into the ordinary overlap layout. Near
 * midnight the synthetic interval shifts upward so its compact block remains
 * wholly visible on the reminder's due day.
 */
export const timedTaskSlot = (
  task: Pick<TaskRecord, 'dueDate' | 'dueTime'>,
  timeZone: string,
):
  | {
      readonly endUtc: number;
      readonly layoutEndMinute: number;
      readonly layoutStartMinute: number;
      readonly startUtc: number;
    }
  | undefined => {
  const due = taskDateTime(task, timeZone);
  if (due === undefined || task.dueDate === undefined) {
    return undefined;
  }
  const dayEnd = Temporal.PlainDate.from(task.dueDate)
    .add({ days: 1 })
    .toZonedDateTime({ timeZone }).epochMilliseconds;
  const durationMs = TIMED_TASK_LAYOUT_MINUTES * 60 * 1000;
  const startUtc = Math.min(due.epochMilliseconds, dayEnd - durationMs);
  const layoutStartMinute = Math.min(
    due.hour * 60 + due.minute,
    24 * 60 - TIMED_TASK_LAYOUT_MINUTES,
  );
  return {
    endUtc: startUtc + durationMs,
    layoutEndMinute: layoutStartMinute + TIMED_TASK_LAYOUT_MINUTES,
    layoutStartMinute,
    startUtc,
  };
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Move a timed reminder with the calendar's 15-minute, wall-clock drag rules. */
export const moveTimedTask = (
  task: Pick<TaskRecord, 'dueDate' | 'dueTime'>,
  timeZone: string,
  deltaMinutes: number,
  deltaDays = 0,
): { readonly dueDate?: string; readonly dueTime?: string } | undefined => {
  const due = taskDateTime(task, timeZone);
  if (due === undefined) {
    return undefined;
  }
  const moved = due
    .toPlainDateTime()
    .add({ days: deltaDays, minutes: snapMinutes(deltaMinutes) })
    .toZonedDateTime(timeZone);
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
