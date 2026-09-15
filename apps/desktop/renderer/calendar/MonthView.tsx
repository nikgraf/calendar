import {
  BIRTHDAY_ACCENT,
  type BirthdayOccurrence,
  birthdayChipLabel,
  buildMonthGrid,
  type EventRecord,
  groupByDate,
  groupEventsByDay,
  taskChipLabel,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { chipTextColor, type ColorLookup } from './colors.ts';

const MAX_CHIPS = 3;

// A cell's items in the all-day lane's order: tasks, birthdays, then the
// day's events (all-day first). Chips are read-only summaries — the cell
// opens the day, where the full chips with toggle and editor live.
type CellItem =
  | { readonly birthday: BirthdayOccurrence; readonly kind: 'birthday' }
  | { readonly event: EventRecord; readonly kind: 'event' }
  | { readonly kind: 'task'; readonly task: TaskRecord };

export function MonthView({
  birthdays,
  colorOf,
  events,
  listColorOf,
  onSelectDay,
  tasks,
  timeZone,
  yearMonth,
}: {
  birthdays: ReadonlyArray<BirthdayOccurrence>;
  colorOf: ColorLookup;
  events: ReadonlyArray<EventRecord>;
  listColorOf: (task: TaskRecord) => string | undefined;
  onSelectDay: (date: Temporal.PlainDate) => void;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  yearMonth: Temporal.PlainYearMonth;
}) {
  const today = Temporal.Now.plainDateISO(timeZone);
  const weeks = buildMonthGrid(yearMonth, today);

  // One pass over each kind, not one filter + sort per cell.
  const eventsByDay = groupEventsByDay(
    events,
    weeks.flat().map((cell) => cell.date),
    timeZone,
  );
  const tasksByDay = groupByDate(tasks, (task) => task.dueDate);
  const birthdaysByDay = groupByDate(birthdays, (birthday) => birthday.date);
  const itemsForDay = (date: Temporal.PlainDate): ReadonlyArray<CellItem> => {
    const iso = date.toString();
    return [
      ...(tasksByDay.get(iso) ?? []).map((task): CellItem => ({ kind: 'task', task })),
      ...(birthdaysByDay.get(iso) ?? []).map((birthday): CellItem => ({
        birthday,
        kind: 'birthday',
      })),
      ...(eventsByDay.get(iso) ?? []).map((event): CellItem => ({ event, kind: 'event' })),
    ];
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-neutral-200 bg-white">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
          <div className="px-2 py-1.5 text-xs font-medium text-neutral-400" key={label}>
            {label}
          </div>
        ))}
      </div>
      <div
        className="grid min-h-0 flex-1 grid-cols-7"
        style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}
      >
        {weeks.flat().map(({ date, inMonth, isToday }) => {
          const items = itemsForDay(date);
          const overflow = items.length - MAX_CHIPS;
          return (
            <button
              className={`flex min-h-0 flex-col items-stretch gap-0.5 border-r border-b border-neutral-100 p-1 text-left ${
                inMonth ? 'bg-white' : 'bg-neutral-50'
              } hover:bg-blue-50/40`}
              key={date.toString()}
              onClick={() => onSelectDay(date)}
              type="button"
            >
              <span
                className={`self-start text-xs font-semibold ${
                  isToday
                    ? 'flex size-5 items-center justify-center rounded-full bg-red-500 text-white'
                    : inMonth
                      ? 'text-neutral-700'
                      : 'text-neutral-300'
                }`}
              >
                {date.day}
              </span>
              {items.slice(0, MAX_CHIPS).map((item) => {
                if (item.kind === 'task') {
                  const { task } = item;
                  const done = task.status === 'completed';
                  return (
                    <span
                      className={`truncate rounded border border-neutral-300 bg-neutral-50 px-1 text-[11px] leading-4 text-neutral-700 ${
                        done ? 'opacity-50' : ''
                      }`}
                      key={`task:${task.listId}:${task.id}`}
                      style={{
                        borderLeftColor: listColorOf(task) ?? '#d4d4d4',
                        borderLeftWidth: 3,
                      }}
                      title={task.title}
                    >
                      <span className={done ? 'line-through' : ''}>
                        {done ? '☑' : '☐'} {taskChipLabel(task)}
                      </span>
                    </span>
                  );
                }
                if (item.kind === 'birthday') {
                  const { birthday } = item;
                  const label = birthdayChipLabel(birthday);
                  return (
                    <span
                      className="truncate rounded border border-neutral-300 bg-neutral-50 px-1 text-[11px] leading-4 text-neutral-700"
                      data-birthday={birthday.record.id}
                      key={`birthday:${birthday.record.id}:${birthday.date}`}
                      style={{ borderLeftColor: BIRTHDAY_ACCENT, borderLeftWidth: 3 }}
                      title={label}
                    >
                      {label}
                    </span>
                  );
                }
                const { event } = item;
                const color = colorOf(event);
                return (
                  <span
                    className="truncate rounded px-1 text-[11px] leading-4"
                    key={`${event.calendarId}:${event.id}`}
                    style={
                      event.isAllDay
                        ? { backgroundColor: color, color: chipTextColor(color) }
                        : { color: '#404040' }
                    }
                  >
                    {event.isAllDay ? null : (
                      <span
                        className="mr-1 inline-block size-1.5 rounded-full align-middle"
                        style={{ backgroundColor: color }}
                      />
                    )}
                    {event.title}
                  </span>
                );
              })}
              {overflow > 0 ? (
                <span className="px-1 text-[10px] text-neutral-400">+{overflow} more</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
