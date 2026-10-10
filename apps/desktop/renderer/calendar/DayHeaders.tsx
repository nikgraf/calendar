import { Temporal } from '@calendar/core';
import type { CSSProperties } from 'react';

/** Weekday + day-number cells over the strip's columns. */
export function DayHeaders({
  gutterClassName,
  scrollbarWidth,
  strip,
  stripStyle,
  today,
}: {
  /** The hour gutter's width class, so the header's spacer matches it. */
  gutterClassName: string;
  scrollbarWidth: number;
  strip: ReadonlyArray<Temporal.PlainDate>;
  stripStyle: CSSProperties;
  today: Temporal.PlainDate;
}) {
  return (
    <div
      className="flex shrink-0 border-b border-hairline bg-surface"
      style={{ paddingRight: scrollbarWidth }}
    >
      <div className={`shrink-0 ${gutterClassName}`} />
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
                className="flex h-10 items-center gap-1.5 border-l border-hairline px-2"
                data-date={day.toString()}
                data-testid={isToday ? 'today-header' : undefined}
                key={day.toString()}
              >
                <span
                  className={`text-xs font-medium uppercase ${isToday ? 'text-primary' : 'text-ink-secondary'}`}
                >
                  {day.toLocaleString('en-US', { weekday: 'short' })}
                </span>
                <span
                  className={`text-sm font-semibold ${
                    isToday
                      ? 'flex size-6 items-center justify-center rounded-full bg-primary text-on-primary'
                      : 'text-ink'
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
