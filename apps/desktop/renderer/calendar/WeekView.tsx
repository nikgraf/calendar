import {
  dayRange,
  layoutAllDayLane,
  layoutDayColumn,
  Temporal,
  utcMsToPlainDate,
  type EventRecord,
} from '@calendar/core';
import { useNow } from '@calendar/app-state';
import { useEffect, useRef } from 'react';
import { chipTextColor, type ColorLookup } from './colors.ts';

const HOUR_HEIGHT = 48;

const formatTime = (epochMs: number, timeZone: string): string =>
  Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timeZone)
    .toPlainTime()
    .toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

const dayIndexOf = (isoDate: string, days: ReadonlyArray<Temporal.PlainDate>): number => {
  const date = Temporal.PlainDate.from(isoDate);
  return days.findIndex((day) => Temporal.PlainDate.compare(day, date) === 0);
};

export function WeekView({
  colorOf,
  days,
  events,
  onEventClick,
  onSlotClick,
  timeZone,
}: {
  colorOf: ColorLookup;
  days: ReadonlyArray<Temporal.PlainDate>;
  events: ReadonlyArray<EventRecord>;
  onEventClick: (event: EventRecord) => void;
  onSlotClick: (date: Temporal.PlainDate, hour: number) => void;
  timeZone: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = Temporal.Now.plainDateISO(timeZone);
  const nowMs = useNow();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 7.5 * HOUR_HEIGHT });
  }, []);

  const allDayEvents = events.filter((event) => event.isAllDay);
  const timedEvents = events.filter((event) => !event.isAllDay);

  const { placed: allDayPlaced, rowCount } = layoutAllDayLane(
    allDayEvents.map((event) => {
      const startIndex = event.startDate ? dayIndexOf(event.startDate, days) : -1;
      const endIso = event.endDate ?? utcMsToPlainDate(event.endUtc);
      const endDate = Temporal.PlainDate.from(endIso);
      const first = days[0]!;
      return {
        endDayIndex:
          Temporal.PlainDate.compare(endDate, days.at(-1)!) > 0
            ? days.length
            : Math.max(first.until(endDate).days, 0),
        id: `${event.calendarId}:${event.id}`,
        startDayIndex:
          startIndex === -1 && event.startDate
            ? Math.min(first.until(Temporal.PlainDate.from(event.startDate)).days, 0)
            : startIndex,
      };
    }),
    days.length,
  );
  const allDayById = new Map(
    allDayEvents.map((event) => [`${event.calendarId}:${event.id}`, event]),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day headers */}
      <div
        className="grid shrink-0 border-b border-neutral-200 bg-white pr-3"
        style={{ gridTemplateColumns: `64px repeat(${days.length}, 1fr)` }}
      >
        <div />
        {days.map((day) => {
          const isToday = Temporal.PlainDate.compare(day, today) === 0;
          return (
            <div
              className="flex items-baseline gap-1.5 border-l border-neutral-100 px-2 py-2"
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

      {/* All-day lane */}
      {rowCount > 0 ? (
        <div
          className="relative grid shrink-0 border-b border-neutral-200 bg-white pr-3"
          style={{
            gridTemplateColumns: `64px repeat(${days.length}, 1fr)`,
            height: rowCount * 24 + 8,
          }}
        >
          <div className="py-1 pr-2 text-right text-[10px] text-neutral-400">all-day</div>
          <div className="relative" style={{ gridColumn: `2 / span ${days.length}` }}>
            {allDayPlaced.map((span) => {
              const event = allDayById.get(span.id)!;
              const color = colorOf(event);
              return (
                <div
                  className="absolute cursor-pointer truncate rounded px-1.5 text-xs leading-5"
                  key={span.id}
                  onClick={() => onEventClick(event)}
                  style={{
                    backgroundColor: color,
                    color: chipTextColor(color),
                    left: `calc(${(span.startDayIndex / days.length) * 100}% + 2px)`,
                    top: span.row * 24 + 4,
                    width: `calc(${((span.endDayIndex - span.startDayIndex) / days.length) * 100}% - 4px)`,
                  }}
                  title={event.title}
                >
                  {event.title}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Timed grid */}
      <div className="min-h-0 flex-1 overflow-y-scroll" ref={scrollRef}>
        <div
          className="relative grid"
          style={{
            gridTemplateColumns: `64px repeat(${days.length}, 1fr)`,
            height: 24 * HOUR_HEIGHT,
          }}
        >
          {/* Hour gutter */}
          <div className="relative">
            {Array.from({ length: 23 }, (_, index) => (
              <span
                className="absolute right-2 -translate-y-1/2 text-[10px] text-neutral-400"
                key={index + 1}
                style={{ top: (index + 1) * HOUR_HEIGHT }}
              >
                {new Temporal.PlainTime(index + 1).toLocaleString('en-US', {
                  hour: 'numeric',
                })}
              </span>
            ))}
          </div>

          {days.map((day) => {
            const range = dayRange(day, timeZone);
            const boxes = layoutDayColumn(
              timedEvents
                .filter((event) => event.startUtc < range.endUtc && event.endUtc > range.startUtc)
                .map((event) => ({
                  endUtc: event.endUtc,
                  id: `${event.calendarId}:${event.id}`,
                  startUtc: event.startUtc,
                })),
              range.startUtc,
              range.endUtc,
            );
            const eventsById = new Map(
              timedEvents.map((event) => [`${event.calendarId}:${event.id}`, event]),
            );
            const isToday = Temporal.PlainDate.compare(day, today) === 0;
            const nowFraction = (nowMs - range.startUtc) / (range.endUtc - range.startUtc);

            return (
              <div
                className="relative border-l border-neutral-100"
                key={day.toString()}
                onClick={(clickEvent) => {
                  const bounds = clickEvent.currentTarget.getBoundingClientRect();
                  const hour = Math.floor((clickEvent.clientY - bounds.top) / HOUR_HEIGHT);
                  onSlotClick(day, Math.min(Math.max(hour, 0), 23));
                }}
              >
                {/* Hour lines */}
                {Array.from({ length: 24 }, (_, index) => (
                  <div
                    className="absolute right-0 left-0 border-t border-neutral-100"
                    key={index}
                    style={{ top: index * HOUR_HEIGHT }}
                  />
                ))}

                {boxes.map((box) => {
                  const event = eventsById.get(box.id)!;
                  const color = colorOf(event);
                  const compact = box.height * 24 * HOUR_HEIGHT < 28;
                  return (
                    <div
                      className="absolute cursor-pointer overflow-hidden rounded-md px-1.5 py-0.5"
                      key={box.id}
                      onClick={(clickEvent) => {
                        clickEvent.stopPropagation();
                        onEventClick(event);
                      }}
                      style={{
                        backgroundColor: color,
                        color: chipTextColor(color),
                        height: `max(${box.height * 100}%, 14px)`,
                        left: `calc(${box.left * 100}% + 1px)`,
                        top: `${box.top * 100}%`,
                        width: `calc(${box.width * 100}% - 3px)`,
                      }}
                      title={`${event.title} · ${formatTime(event.startUtc, timeZone)}`}
                    >
                      <p className="truncate text-xs leading-4 font-medium">{event.title}</p>
                      {compact ? null : (
                        <p className="truncate text-[10px] opacity-80">
                          {formatTime(event.startUtc, timeZone)} –{' '}
                          {formatTime(event.endUtc, timeZone)}
                        </p>
                      )}
                    </div>
                  );
                })}

                {/* Now indicator */}
                {isToday && nowFraction >= 0 && nowFraction <= 1 ? (
                  <div
                    className="absolute right-0 left-0 z-10 border-t-2 border-red-500"
                    style={{ top: `${nowFraction * 100}%` }}
                  >
                    <span className="absolute -top-[5px] -left-1 size-2 rounded-full bg-red-500" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
