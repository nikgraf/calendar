import { partitionCalendarTasks, taskCalendarDate } from '../taskTiming.ts';
import { toZonedDateTime } from '../time/convert.ts';
import type { Temporal } from '../time/temporal.ts';
import type { BirthdayOccurrence, EventRecord, TaskRecord } from '../types.ts';
import { groupEventsByDay } from './dayGrouping.ts';

export type AgendaItem =
  | { readonly birthday: BirthdayOccurrence; readonly kind: 'birthday' }
  | { readonly event: EventRecord; readonly kind: 'event' }
  | { readonly kind: 'task'; readonly task: TaskRecord };

export interface AgendaDay {
  /** 'YYYY-MM-DD'. */
  readonly date: string;
  /** Empty for a day with nothing on it — the list still shows the day. */
  readonly items: ReadonlyArray<AgendaItem>;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** The wall-clock time a timed item sorts by; all-day items sort first. */
const timeOf = (item: AgendaItem, timeZone: string): string => {
  if (item.kind === 'event') {
    if (item.event.isAllDay) {
      return '';
    }
    const start = toZonedDateTime(item.event.startUtc, timeZone);
    return `${pad(start.hour)}:${pad(start.minute)}`;
  }
  return item.kind === 'task' ? (item.task.dueTime ?? '') : '';
};

/**
 * The agenda list: one entry per day in `days`, each holding what the
 * calendar would draw on it — all-day events, birthdays and dated tasks
 * first (overdue and undated tasks on today, like the grid), then the
 * timed events and reminders in time order. Days with nothing stay in
 * the list, so a free day reads as free.
 */
export const buildAgenda = ({
  birthdays,
  days,
  events,
  tasks,
  timeZone,
  today,
}: {
  readonly birthdays: ReadonlyArray<BirthdayOccurrence>;
  readonly days: ReadonlyArray<Temporal.PlainDate>;
  readonly events: ReadonlyArray<EventRecord>;
  /** A window's tasks plus the overdue ones; doubles are dropped. */
  readonly tasks: ReadonlyArray<TaskRecord>;
  readonly timeZone: string;
  readonly today: string;
}): ReadonlyArray<AgendaDay> => {
  const eventsByDay = groupEventsByDay(events, days, timeZone);
  const { allDay, overdue, timed, undated } = partitionCalendarTasks(tasks, today, timeZone);
  const tasksByDay = new Map<string, Array<TaskRecord>>();
  const place = (task: TaskRecord) => {
    const day = taskCalendarDate(task, today, timeZone);
    tasksByDay.set(day, [...(tasksByDay.get(day) ?? []), task]);
  };
  for (const task of [...overdue, ...undated, ...allDay, ...timed]) {
    place(task);
  }
  const birthdaysByDay = new Map<string, Array<BirthdayOccurrence>>();
  for (const birthday of birthdays) {
    birthdaysByDay.set(birthday.date, [...(birthdaysByDay.get(birthday.date) ?? []), birthday]);
  }

  return days.map((day) => {
    const date = day.toString();
    const items: Array<AgendaItem> = [
      ...(eventsByDay.get(date) ?? []).map((event) => ({ event, kind: 'event' as const })),
      ...(birthdaysByDay.get(date) ?? []).map((birthday) => ({
        birthday,
        kind: 'birthday' as const,
      })),
      ...(tasksByDay.get(date) ?? []).map((task) => ({ kind: 'task' as const, task })),
    ];
    // A stable sort: all-day items (time '') keep their order above, timed
    // ones interleave by the clock.
    const keyed = items.map((item, index) => ({ index, item, time: timeOf(item, timeZone) }));
    keyed.sort((a, b) => a.time.localeCompare(b.time) || a.index - b.index);
    return { date, items: keyed.map((entry) => entry.item) };
  });
};
