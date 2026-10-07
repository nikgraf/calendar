import {
  type BirthdayOccurrence,
  birthdayChipLabel,
  buildMonthGrid,
  calendarTaskKey,
  type EventRecord,
  formatClockTime,
  groupByDate,
  groupEventsByDay,
  monthCellLabel,
  overdueLabel,
  partitionCalendarTasks,
  taskCalendarDate,
  taskChipLabel,
  type TaskRecord,
  taskRepeats,
  Temporal,
} from '@calendar/core';
import type { ColorLookup } from './colors.ts';
import { eventLook, stripes, useTint } from './tint.ts';

const MAX_CHIPS = 3;

// A cell's items: the day's events (all-day first), then birthdays, then
// tasks. Events lead because they carry the calendar's color and are what
// the month grid showed before; a day full of tasks must not push them
// into "+N more". Each chip opens its own item; the cell (and "+N more")
// opens the day.
type CellItem =
  | { readonly birthday: BirthdayOccurrence; readonly kind: 'birthday' }
  | { readonly event: EventRecord; readonly kind: 'event' }
  | { readonly kind: 'task'; readonly task: TaskRecord };

const CHIP =
  'flex h-4 w-full items-center gap-1 truncate rounded-event px-1 text-left text-[11px] leading-4';

export function MonthView({
  birthdays,
  colorOf,
  events,
  listColorOf,
  onBirthdayClick,
  onEventClick,
  onSelectDay,
  onTaskClick,
  onToggleTask,
  overdue,
  selectedKey,
  tasks,
  timeZone,
  today: todayIso,
  yearMonth,
}: {
  birthdays: ReadonlyArray<BirthdayOccurrence>;
  colorOf: ColorLookup;
  events: ReadonlyArray<EventRecord>;
  listColorOf: (task: TaskRecord) => string | undefined;
  onBirthdayClick: (birthday: BirthdayOccurrence) => void;
  onEventClick: (event: EventRecord) => void;
  onSelectDay: (date: Temporal.PlainDate) => void;
  onTaskClick: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  /** Open tasks due before today; listed on today's cell, not on their past day. */
  overdue: ReadonlyArray<TaskRecord>;
  /** `calendarId:id` of the event open in the side panel. */
  selectedKey: string | undefined;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  today: string;
  yearMonth: Temporal.PlainYearMonth;
}) {
  const tintOf = useTint();
  const today = Temporal.PlainDate.from(todayIso);
  const weeks = buildMonthGrid(yearMonth, today);

  // One pass over each kind, not one filter + sort per cell.
  const eventsByDay = groupEventsByDay(
    events,
    weeks.flat().map((cell) => cell.date),
    timeZone,
  );
  const calendarTasks = partitionCalendarTasks([...tasks, ...overdue], todayIso, timeZone);
  const tasksByDay = groupByDate(calendarTasks.allDay.concat(calendarTasks.timed), (task) =>
    taskCalendarDate(task, todayIso, timeZone),
  );
  // Overdue and undated tasks lead today's cell until they are done.
  const todayTasks = calendarTasks.overdue.concat(calendarTasks.undated);
  const overdueKeys = new Set(calendarTasks.overdue.map(calendarTaskKey));
  const birthdaysByDay = groupByDate(birthdays, (birthday) => birthday.date);

  const chip = (item: CellItem) => {
    if (item.kind === 'task') {
      const { task } = item;
      const done = task.status === 'completed';
      const isOverdue = overdueKeys.has(calendarTaskKey(task));
      // The list accent only where the lane draws one: a colored
      // Reminders list. Google lists stay neutral.
      const listColor = listColorOf(task);
      return (
        <span
          className={`${CHIP} bg-fill ${isOverdue ? 'text-danger' : 'text-ink-secondary'} ${
            done ? 'opacity-50' : ''
          }`}
          data-overdue={isOverdue ? '' : undefined}
          key={calendarTaskKey(task)}
          title={isOverdue ? `${task.title} · ${overdueLabel(task, todayIso)}` : task.title}
        >
          <button
            aria-label={done ? `Reopen task ${task.title}` : `Complete task ${task.title}`}
            className="shrink-0"
            onClick={(mouse) => {
              mouse.stopPropagation();
              onToggleTask(task);
            }}
            type="button"
          >
            {done ? '☑' : '☐'}
          </button>
          {listColor ? (
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: listColor }}
            />
          ) : null}
          <button
            className={`min-w-0 flex-1 truncate text-left ${done ? 'line-through' : ''}`}
            onClick={(mouse) => {
              mouse.stopPropagation();
              onTaskClick(task);
            }}
            type="button"
          >
            {taskChipLabel(task, { overdue: isOverdue, repeats: taskRepeats(task) })}
          </button>
        </span>
      );
    }
    if (item.kind === 'birthday') {
      const { birthday } = item;
      const label = birthdayChipLabel(birthday);
      return (
        <button
          className={`${CHIP} bg-event-blush text-on-event-blush`}
          data-birthday={birthday.record.id}
          key={`birthday:${birthday.record.id}:${birthday.date}`}
          onClick={(mouse) => {
            mouse.stopPropagation();
            onBirthdayClick(birthday);
          }}
          title={label}
          type="button"
        >
          <span className="truncate">{label}</span>
        </button>
      );
    }
    const { event } = item;
    const color = colorOf(event);
    const tint = tintOf(color);
    const look = eventLook(event);
    const selected = selectedKey === `${event.calendarId}:${event.id}`;
    return (
      <button
        className={`${CHIP} ${selected ? 'ring-2 ring-primary' : ''} ${look.declined ? 'opacity-60' : ''}`}
        data-color={color}
        key={`${event.calendarId}:${event.id}`}
        onClick={(mouse) => {
          mouse.stopPropagation();
          onEventClick(event);
        }}
        style={
          event.isAllDay
            ? {
                backgroundColor: tint.fill,
                backgroundImage: look.tentative ? stripes(tint.edge) : undefined,
                color: tint.text,
              }
            : { color: 'var(--text)' }
        }
        title={event.title}
        type="button"
      >
        {event.isAllDay ? null : (
          <>
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: tint.edge }}
            />
            <span className="shrink-0 text-ink-secondary">
              {formatClockTime(event.startUtc, timeZone)}
            </span>
          </>
        )}
        <span className={`truncate ${look.declined ? 'line-through' : ''}`}>{event.title}</span>
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="month-grid">
      <div className="grid shrink-0 grid-cols-7 border-b border-hairline bg-surface">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
          <div className="px-2 py-1.5 text-xs font-medium text-ink-secondary" key={label}>
            {label}
          </div>
        ))}
      </div>
      <div
        className="grid min-h-0 flex-1 grid-cols-7"
        style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}
      >
        {weeks.flat().map(({ date, inMonth, isToday }) => {
          const iso = date.toString();
          const dayEvents = eventsByDay.get(iso) ?? [];
          const dayBirthdays = birthdaysByDay.get(iso) ?? [];
          const dayTasks = (isToday ? todayTasks : []).concat(tasksByDay.get(iso) ?? []);
          const items: ReadonlyArray<CellItem> = [
            ...dayEvents.map((event): CellItem => ({ event, kind: 'event' })),
            ...dayBirthdays.map((birthday): CellItem => ({ birthday, kind: 'birthday' })),
            ...dayTasks.map((task): CellItem => ({ kind: 'task', task })),
          ];
          const overflow = items.length - MAX_CHIPS;
          return (
            // A div, not a button: the chips inside are buttons of their own.
            <div
              aria-label={monthCellLabel(date, {
                birthdays: dayBirthdays.length,
                events: dayEvents.length,
                tasks: dayTasks.length,
              })}
              className={`flex min-h-0 cursor-default flex-col items-stretch gap-0.5 border-r border-b border-hairline p-1 text-left outline-none focus-visible:bg-selection/40 ${
                inMonth ? 'bg-surface' : 'bg-surface-subtle'
              } hover:bg-selection/40`}
              key={iso}
              onClick={() => onSelectDay(date)}
              onKeyDown={(key) => {
                if (key.target === key.currentTarget && (key.key === 'Enter' || key.key === ' ')) {
                  key.preventDefault();
                  onSelectDay(date);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span
                className={`self-start text-xs font-semibold ${
                  isToday
                    ? 'flex size-5 items-center justify-center rounded-full bg-primary text-on-primary'
                    : inMonth
                      ? 'text-ink-secondary'
                      : 'text-ink-secondary/70'
                }`}
              >
                {date.day}
              </span>
              {items.slice(0, MAX_CHIPS).map(chip)}
              {overflow > 0 ? (
                <span className="px-1 text-[10px] text-ink-secondary">+{overflow} more</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
