import {
  bufferedDays,
  dayRange,
  type EventRecord,
  layoutAllDayLane,
  layoutDayColumn,
  PAN_BUFFER_DAYS,
  type TaskRecord,
  Temporal,
  utcMsToPlainDate,
} from '@calendar/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AllDayLane } from './AllDayLane.tsx';
import { type ColorLookup } from './colors.ts';
import { DayHeaders } from './DayHeaders.tsx';
import { NowIndicator } from './NowIndicator.tsx';
import { TimedEventBlock } from './TimedEventBlock.tsx';
import { useEventDrag } from './useEventDrag.ts';
import { useWheelPan } from './useWheelPan.ts';

const HOUR_HEIGHT = 48;
/** Hour lines as one repeating gradient (neutral-100), not 24 divs per column. */
const HOUR_LINES = `repeating-linear-gradient(to bottom, #f5f5f5 0, #f5f5f5 1px, transparent 1px, transparent ${HOUR_HEIGHT}px)`;

const dayIndexOf = (isoDate: string, days: ReadonlyArray<Temporal.PlainDate>): number => {
  const date = Temporal.PlainDate.from(isoDate);
  return days.findIndex((day) => Temporal.PlainDate.compare(day, date) === 0);
};

export function WeekView({
  colorOf,
  days,
  events,
  listColorOf,
  onEventClick,
  onNavigate,
  onSlotClick,
  onTaskClick,
  onToggleTask,
  tasks,
  timeZone,
}: {
  colorOf: ColorLookup;
  days: ReadonlyArray<Temporal.PlainDate>;
  events: ReadonlyArray<EventRecord>;
  listColorOf: (task: TaskRecord) => string | undefined;
  onEventClick: (event: EventRecord) => void;
  onNavigate: (dayCount: number) => void;
  onSlotClick: (date: Temporal.PlainDate, hour: number) => void;
  onTaskClick: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const today = Temporal.Now.plainDateISO(timeZone);

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

  // Tasks join the same lane as one-day spans so they pack into shared
  // rows with all-day events and the lane height stays consistent.
  const taskSpans = tasks.flatMap((task) => {
    if (!task.dueDate) {
      return [];
    }
    const index = dayIndexOf(task.dueDate, strip);
    return index === -1
      ? []
      : [{ endDayIndex: index + 1, id: `task:${task.listId}:${task.id}`, startDayIndex: index }];
  });
  const taskById = new Map(tasks.map((task) => [`task:${task.listId}:${task.id}`, task]));

  const { placed: allDayPlaced, rowCount } = layoutAllDayLane(
    taskSpans.concat(
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
    ),
    strip.length,
  );
  const allDayById = new Map(
    allDayEvents.map((event) => [`${event.calendarId}:${event.id}`, event]),
  );
  // Built once per render, not once per column: this component re-renders
  // on every drag pointermove, and the strip is up to 11 columns wide.
  const eventsById = new Map(
    timedEvents.map((event) => [`${event.calendarId}:${event.id}`, event]),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={rootRef}>
      <DayHeaders
        scrollbarWidth={scrollbarWidth}
        strip={strip}
        stripStyle={stripStyle}
        today={today}
      />

      <AllDayLane
        allDayById={allDayById}
        colorOf={colorOf}
        listColorOf={listColorOf}
        onEventClick={onEventClick}
        onTaskClick={onTaskClick}
        onToggleTask={onToggleTask}
        placed={allDayPlaced}
        rowCount={rowCount}
        scrollbarWidth={scrollbarWidth}
        stripLength={strip.length}
        stripStyle={stripStyle}
        taskById={taskById}
      />

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
                const isToday = Temporal.PlainDate.compare(day, today) === 0;

                return (
                  <div
                    aria-label={`${day.toLocaleString('en-US', { day: 'numeric', month: 'long', weekday: 'long' })}: press Enter for a new event`}
                    className="relative border-l border-neutral-100 outline-none focus-visible:bg-blue-50/40"
                    key={day.toString()}
                    onClick={(clickEvent) => {
                      if (drag.consumeSuppressedClick()) {
                        return;
                      }
                      const bounds = clickEvent.currentTarget.getBoundingClientRect();
                      const hour = Math.floor((clickEvent.clientY - bounds.top) / HOUR_HEIGHT);
                      onSlotClick(day, Math.min(Math.max(hour, 0), 23));
                    }}
                    onKeyDown={(keyEvent) => {
                      if (keyEvent.target === keyEvent.currentTarget && keyEvent.key === 'Enter') {
                        keyEvent.preventDefault();
                        onSlotClick(day, 9);
                      }
                    }}
                    role="button"
                    // One gradient instead of 24 hour-line divs per column.
                    style={{ backgroundImage: HOUR_LINES }}
                    tabIndex={0}
                  >
                    {boxes.map((box) => {
                      const event = eventsById.get(box.id)!;
                      return (
                        <TimedEventBlock
                          box={box}
                          color={colorOf(event)}
                          drag={drag}
                          event={event}
                          hourHeight={HOUR_HEIGHT}
                          key={box.id}
                          onEventClick={onEventClick}
                          timeZone={timeZone}
                        />
                      );
                    })}

                    {isToday ? (
                      <NowIndicator rangeEndUtc={range.endUtc} rangeStartUtc={range.startUtc} />
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
