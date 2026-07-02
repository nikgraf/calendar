import { buildMonthGrid, dayRange, Temporal, type EventRecord } from '@calendar/core';
import { chipTextColor, type ColorLookup } from './colors.ts';

const MAX_CHIPS = 3;

export function MonthView({
  colorOf,
  events,
  onSelectDay,
  timeZone,
  yearMonth,
}: {
  colorOf: ColorLookup;
  events: ReadonlyArray<EventRecord>;
  onSelectDay: (date: Temporal.PlainDate) => void;
  timeZone: string;
  yearMonth: Temporal.PlainYearMonth;
}) {
  const today = Temporal.Now.plainDateISO(timeZone);
  const weeks = buildMonthGrid(yearMonth, today);

  const eventsForDay = (date: Temporal.PlainDate): Array<EventRecord> => {
    const range = dayRange(date, timeZone);
    return events
      .filter((event) => event.startUtc < range.endUtc && event.endUtc > range.startUtc)
      .sort((a, b) => Number(b.isAllDay) - Number(a.isAllDay) || a.startUtc - b.startUtc);
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
          const dayEvents = eventsForDay(date);
          const overflow = dayEvents.length - MAX_CHIPS;
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
              {dayEvents.slice(0, MAX_CHIPS).map((event) => {
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
