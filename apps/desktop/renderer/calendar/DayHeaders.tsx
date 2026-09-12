import { Temporal } from '@calendar/core';
import type { CSSProperties } from 'react';

/** Weekday + day-number cells over the strip's columns. */
export function DayHeaders({
  scrollbarWidth,
  strip,
  stripStyle,
  today,
}: {
  scrollbarWidth: number;
  strip: ReadonlyArray<Temporal.PlainDate>;
  stripStyle: CSSProperties;
  today: Temporal.PlainDate;
}) {
  return (
    <div
      className="flex shrink-0 border-b border-neutral-200 bg-white"
      style={{ paddingRight: scrollbarWidth }}
    >
      <div className="w-16 shrink-0" />
      <div className="min-w-0 flex-1 overflow-hidden">
        <div
          className="grid"
          style={{
            ...stripStyle,
            gridTemplateColumns: `repeat(${strip.length}, 1fr)`,
          }}
        >
          {strip.map((day) => {
            const isToday = Temporal.PlainDate.compare(day, today) === 0;
            return (
              <div
                // Fixed height: the today-circle is taller than plain text,
                // and a header that resizes while panning shifts the grid.
                className="flex h-10 items-center gap-1.5 border-l border-neutral-100 px-2"
                key={day.toString()}
              >
                <span className="text-xs font-medium text-neutral-400 uppercase">
                  {day.toLocaleString('en-US', { weekday: 'short' })}
                </span>
                <span
                  className={`text-sm font-semibold ${
                    isToday
                      ? 'flex size-6 items-center justify-center rounded-full bg-red-500 text-white'
                      : 'text-neutral-700'
                  }`}
                >
                  {day.day}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
