import {
  bufferedDays,
  dayRange,
  layoutAllDayLane,
  layoutDayColumn,
  PAN_BUFFER_DAYS,
  Temporal,
  utcMsToPlainDate,
  type EventRecord,
} from '@calendar/core';
import { useNow } from '@calendar/app-state';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { chipTextColor, type ColorLookup } from './colors.ts';
import { useEventDrag } from './useEventDrag.ts';
import { useWheelPan } from './useWheelPan.ts';

const HOUR_HEIGHT = 48;
const MINUTE_MS = 60 * 1000;

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
  onNavigate,
  onSlotClick,
  timeZone,
}: {
  colorOf: ColorLookup;
  days: ReadonlyArray<Temporal.PlainDate>;
  events: ReadonlyArray<EventRecord>;
  onEventClick: (event: EventRecord) => void;
  onNavigate: (dayCount: number) => void;
  onSlotClick: (date: Temporal.PlainDate, hour: number) => void;
  timeZone: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const today = Temporal.Now.plainDateISO(timeZone);
  const nowMs = useNow();

  // The pan strip renders buffer columns on both sides of the visible days
  // so horizontal panning reveals fully drawn neighbours.
  const strip = useMemo(() => bufferedDays(days[0]!, days.length, PAN_BUFFER_DAYS), [days]);
  // Strips are (buffered/visible)× as wide as their clipped viewport and
  // sit shifted left by the leading buffer; `--pan-x` (set imperatively by
  // useWheelPan on the root) adds the live gesture offset.
  const stripStyle = {
    transform: `translateX(calc(${-(PAN_BUFFER_DAYS / strip.length) * 100}% + var(--pan-x, 0px)))`,
    width: `${(strip.length / days.length) * 100}%`,
  };

  const drag = useEventDrag({
    dayCount: strip.length,
    gridRef,
    hourHeight: HOUR_HEIGHT,
    onClick: onEventClick,
  });

  useWheelPan({
    // Mid-drag day jumps would corrupt the drop target.
    enabled: drag.preview === null,
    firstDay: days[0]!,
    onCommitDays: onNavigate,
    rootRef,
    scrollerRef: scrollRef,
    viewportRef,
    visibleDayCount: days.length,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 7.5 * HOUR_HEIGHT });
  }, []);

  // Header and all-day rows pad their right edge by the timed scroller's
  // actual scrollbar width (0 for macOS overlay scrollbars) so all three
  // sections share one viewport width — hardcoded padding would skew the
  // column widths and misalign headers from the grid.
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }
    const measure = () => setScrollbarWidth(scroller.offsetWidth - scroller.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const allDayEvents = events.filter((event) => event.isAllDay);
  const timedEvents = events.filter((event) => !event.isAllDay);

  const { placed: allDayPlaced, rowCount } = layoutAllDayLane(
    allDayEvents.map((event) => {
      const startIndex = event.startDate ? dayIndexOf(event.startDate, strip) : -1;
      const endIso = event.endDate ?? utcMsToPlainDate(event.endUtc);
      const endDate = Temporal.PlainDate.from(endIso);
      const first = strip[0]!;
      return {
        endDayIndex:
          Temporal.PlainDate.compare(endDate, strip.at(-1)!) > 0
            ? strip.length
            : Math.max(first.until(endDate).days, 0),
        id: `${event.calendarId}:${event.id}`,
        startDayIndex:
          startIndex === -1 && event.startDate
            ? Math.min(first.until(Temporal.PlainDate.from(event.startDate)).days, 0)
            : startIndex,
      };
    }),
    strip.length,
  );
  const allDayById = new Map(
    allDayEvents.map((event) => [`${event.calendarId}:${event.id}`, event]),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={rootRef}>
      {/* Day headers */}
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

      {/* All-day lane — always rendered (empty row when no all-day events) so
          the timed grid never jumps vertically while panning across weeks
          where the lane would otherwise mount/unmount. */}
      <div
        className="flex shrink-0 border-b border-neutral-200 bg-white"
        style={{ height: Math.max(rowCount, 1) * 24 + 8, paddingRight: scrollbarWidth }}
      >
        <div className="w-16 shrink-0 py-1 pr-2 text-right text-[10px] text-neutral-400">
          all-day
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="relative h-full" style={stripStyle}>
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
                    left: `calc(${(span.startDayIndex / strip.length) * 100}% + 2px)`,
                    top: span.row * 24 + 4,
                    width: `calc(${((span.endDayIndex - span.startDayIndex) / strip.length) * 100}% - 4px)`,
                  }}
                  title={event.title}
                >
                  {event.title}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Timed grid */}
      <div className="min-h-0 flex-1 overflow-y-scroll" ref={scrollRef}>
        <div className="flex" style={{ height: 24 * HOUR_HEIGHT }}>
          {/* Hour gutter */}
          <div className="relative w-16 shrink-0">
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

          <div className="min-w-0 flex-1 overflow-hidden" ref={viewportRef}>
            <div
              className="relative grid h-full"
              ref={gridRef}
              style={{
                ...stripStyle,
                gridTemplateColumns: `repeat(${strip.length}, 1fr)`,
              }}
            >
              {strip.map((day) => {
                const range = dayRange(day, timeZone);
                const boxes = layoutDayColumn(
                  timedEvents
                    .filter(
                      (event) => event.startUtc < range.endUtc && event.endUtc > range.startUtc,
                    )
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
                      if (drag.consumeSuppressedClick()) {
                        return;
                      }
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
                      const dragging = drag.preview?.eventKey === box.id ? drag.preview : null;
                      const moveMinutes = dragging?.mode === 'move' ? dragging.deltaMinutes : 0;
                      const resizeMinutes = dragging?.mode === 'resize' ? dragging.deltaMinutes : 0;
                      const deltaDays = dragging?.mode === 'move' ? dragging.deltaDays : 0;
                      const dayMinutes = 24 * 60;
                      const topMinutes = box.top * dayMinutes + moveMinutes;
                      const heightMinutes = Math.max(box.height * dayMinutes + resizeMinutes, 15);
                      const previewStart = event.startUtc + moveMinutes * MINUTE_MS;
                      const previewEnd =
                        dragging?.mode === 'resize'
                          ? Math.max(
                              event.endUtc + resizeMinutes * MINUTE_MS,
                              event.startUtc + 15 * MINUTE_MS,
                            )
                          : event.endUtc + moveMinutes * MINUTE_MS;
                      const compact = (heightMinutes / 60) * HOUR_HEIGHT < 28;
                      const draggable = !event.recurrence;
                      return (
                        <div
                          className={`absolute touch-none overflow-hidden rounded-md px-1.5 py-0.5 select-none ${
                            draggable ? 'cursor-grab' : 'cursor-pointer'
                          } ${dragging ? 'z-20 opacity-90 shadow-lg ring-2 ring-white/60' : ''}`}
                          key={box.id}
                          onPointerDown={(pointerEvent) =>
                            drag.onPointerDown(event, box.id, pointerEvent, 'move')
                          }
                          onPointerMove={drag.onPointerMove}
                          onPointerUp={drag.onPointerUp}
                          style={{
                            backgroundColor: color,
                            color: chipTextColor(color),
                            height: `max(${(heightMinutes / dayMinutes) * 100}%, 14px)`,
                            left: `calc(${(box.left + deltaDays) * 100}% + 1px)`,
                            top: `${(topMinutes / dayMinutes) * 100}%`,
                            width: `calc(${box.width * 100}% - 3px)`,
                          }}
                          title={`${event.title} · ${formatTime(event.startUtc, timeZone)}`}
                        >
                          <p className="truncate text-xs leading-4 font-medium">{event.title}</p>
                          {compact ? null : (
                            <p className="truncate text-[10px] opacity-80">
                              {formatTime(dragging ? previewStart : event.startUtc, timeZone)} –{' '}
                              {formatTime(dragging ? previewEnd : event.endUtc, timeZone)}
                            </p>
                          )}
                          {draggable ? (
                            <div
                              className="absolute right-0 bottom-0 left-0 h-2 cursor-ns-resize"
                              onPointerDown={(pointerEvent) =>
                                drag.onPointerDown(event, box.id, pointerEvent, 'resize')
                              }
                            />
                          ) : null}
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
      </div>
    </div>
  );
}
