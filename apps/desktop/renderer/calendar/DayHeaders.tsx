import { Temporal, zoneCity, zoneSlug } from '@calendar/core';
import { zoneInk } from './zoneInk.ts';
import type { CSSProperties } from 'react';

/**
 * Weekday + day-number cells over the strip's columns. The tracks may
 * shrink below a label (`minmax(0, 1fr)`): with plain `1fr` a label that
 * did not fit widened its column, and in a narrow grid (the editor open
 * at 1024 px) the headers drifted off the columns below them. A column
 * too narrow for both shows the day number alone.
 */
export function DayHeaders({
  gutterClassName,
  scrollbarWidth,
  strip,
  stripStyle,
  today,
  zones,
}: {
  /** The hour gutter's width class, so the header's spacer matches it. */
  gutterClassName: string;
  scrollbarWidth: number;
  strip: ReadonlyArray<Temporal.PlainDate>;
  stripStyle: CSSProperties;
  today: Temporal.PlainDate;
  /** Primary first, then the others; empty with one zone. Their cities head the gutter. */
  zones: ReadonlyArray<string>;
}) {
  return (
    <div
      className="flex shrink-0 border-b border-hairline bg-surface"
      style={{ paddingRight: scrollbarWidth }}
    >
      {/* Which zone each gutter line is: the cities in the lines' order and
          shades, the primary on top. */}
      <div
        className={`flex shrink-0 flex-col items-end justify-center pr-2 pl-1 text-[10px] leading-3 ${gutterClassName}`}
        data-testid={zones.length > 0 ? 'zone-cities' : undefined}
      >
        {zones.map((zone, index) => (
          <span
            className={`max-w-full truncate ${index === 0 ? '' : 'text-[9px]'} ${zoneInk(index)}`}
            data-testid={`zone-city-${zoneSlug(zone)}`}
            key={zone}
            title={zoneCity(zone)}
          >
            {zoneCity(zone)}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div
          className="grid"
          style={{
            ...stripStyle,
            gridTemplateColumns: `repeat(${strip.length}, minmax(0, 1fr))`,
          }}
        >
          {strip.map((day) => {
            const isToday = Temporal.PlainDate.compare(day, today) === 0;
            return (
              <div
                // Fixed height: the today-circle is taller than plain text,
                // and a header that resizes while panning shifts the grid.
                className="@container flex h-10 min-w-0 items-center gap-1.5 overflow-hidden border-l border-hairline px-2"
                data-date={day.toString()}
                data-testid={isToday ? 'today-header' : undefined}
                key={day.toString()}
              >
                <span
                  className={`text-xs font-medium uppercase @max-[4.5rem]:hidden ${isToday ? 'text-primary' : 'text-ink-secondary'}`}
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
