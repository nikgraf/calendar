import { buildMonthGrid, Temporal, weekStart } from '@calendar/core';
import { useState } from 'react';
import { IconButton } from '../../ui/IconButton.tsx';
import { ChevronLeftIcon, ChevronRightIcon } from '../../ui/icons.tsx';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * The sidebar's month at a glance: the focused week is highlighted, today
 * filled, and a day click focuses it. Keyed by the focused month in the
 * sidebar, so it follows navigation but can be browsed away in between.
 */
export function MiniMonth({
  focused,
  onPick,
  today,
}: {
  focused: Temporal.PlainDate;
  onPick: (date: Temporal.PlainDate) => void;
  today: Temporal.PlainDate;
}) {
  const [shown, setShown] = useState(() => Temporal.PlainYearMonth.from(focused));
  const focusedWeek = weekStart(focused).toString();
  const weeks = buildMonthGrid(shown, today);
  return (
    <div className="flex flex-col gap-1.5 px-3.5 pt-2 pb-3">
      <div className="flex items-center justify-between pl-1">
        <span className="text-sm font-semibold">
          {/* Through a PlainDate: the polyfill refuses to format an iso8601 PlainYearMonth. */}
          {shown
            .toPlainDate({ day: 1 })
            .toLocaleString('en-US', { month: 'long', year: 'numeric' })}
        </span>
        <span className="flex">
          <IconButton
            label="Previous month"
            onClick={() => setShown(shown.subtract({ months: 1 }))}
            size="sm"
          >
            <ChevronLeftIcon size={14} />
          </IconButton>
          <IconButton
            label="Next month"
            onClick={() => setShown(shown.add({ months: 1 }))}
            size="sm"
          >
            <ChevronRightIcon size={14} />
          </IconButton>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center text-[10.5px] font-medium text-ink-secondary">
        {WEEKDAYS.map((day, index) => (
          <span key={`${day}${String(index)}`}>{day}</span>
        ))}
      </div>
      <div className="flex flex-col gap-px">
        {weeks.map((week) => {
          const start = week[0]!.date.toString();
          return (
            <div
              className={`grid grid-cols-7 rounded-control ${
                start === focusedWeek ? 'bg-selection' : ''
              }`}
              key={start}
            >
              {week.map((day) => (
                <button
                  aria-label={day.date.toLocaleString('en-US', {
                    day: 'numeric',
                    month: 'long',
                    weekday: 'long',
                  })}
                  className="flex h-6.5 items-center justify-center"
                  data-testid={`mini-day-${day.date.toString()}`}
                  key={day.date.toString()}
                  onClick={() => onPick(day.date)}
                  type="button"
                >
                  <span
                    className={`flex size-5.5 items-center justify-center rounded-full text-xs ${
                      day.isToday
                        ? 'bg-primary font-semibold text-on-primary'
                        : day.inMonth
                          ? 'text-ink'
                          : 'text-ink-secondary'
                    }`}
                  >
                    {day.date.day}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
