import { useGuardedMutations, useViewPreferences } from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  bufferedDays,
  calendarTaskKey,
  capAllDayLane,
  dayRange,
  type EventRecord,
  formatPlainTime,
  layoutAllDayLane,
  layoutDayColumn,
  MAX_ALL_DAY_ROWS,
  PAN_BUFFER_DAYS,
  partitionCalendarTasks,
  type SlotRange,
  slotTimes,
  type TaskRecord,
  Temporal,
  timedEventBox,
  type TimedBox,
  timedTaskSlot,
  utcMsToPlainDate,
} from '@calendar/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AllDayLane } from './AllDayLane.tsx';
import { type ColorLookup } from './colors.ts';
import { DayHeaders } from './DayHeaders.tsx';
import { NowIndicator } from './NowIndicator.tsx';
import { TimedEventBlock } from './TimedEventBlock.tsx';
import { TimedTaskBlock } from './TimedTaskBlock.tsx';
import { useDropTarget, useEventDrag } from './useEventDrag.ts';
import { useSlotDrag } from './useSlotDrag.ts';
import { useWheelPan } from './useWheelPan.ts';

const HOUR_HEIGHT = 48;
/** Hour lines as one repeating gradient (neutral-100), not 24 divs per column. */
const HOUR_LINES = `repeating-linear-gradient(to bottom, #f5f5f5 0, #f5f5f5 1px, transparent 1px, transparent ${HOUR_HEIGHT}px)`;

/** The occurrence date keys a birthday: one person recurs every year the strip crosses. */
const birthdayKey = (birthday: BirthdayOccurrence): string =>
  `birthday:${birthday.record.id}:${birthday.date}`;

/** "10:00 AM – 11:30 AM", in the grid's hour-label style. */
const slotLabel = (slot: SlotRange): string => {
  const { endTime, startTime } = slotTimes(slot);
  return `${formatPlainTime(startTime)} – ${formatPlainTime(endTime)}`;
};

const dayIndexOf = (isoDate: string, days: ReadonlyArray<Temporal.PlainDate>): number => {
  const date = Temporal.PlainDate.from(isoDate);
  return days.findIndex((day) => Temporal.PlainDate.compare(day, date) === 0);
};

/** Outlines the grid slot a lane chip would drop into (a timed block shows itself instead). */
function GridDropIndicator({
  drag,
  hourHeight,
  stripLength,
}: {
  drag: ReturnType<typeof useEventDrag>;
  hourHeight: number;
  stripLength: number;
}) {
  const drop = useDropTarget(drag);
  if (drop === null || drop.from !== 'lane' || drop.target.kind !== 'timed') {
    return null;
  }
  return (
    <div
      className="pointer-events-none absolute z-30 h-[22px] rounded border-2 border-dashed border-blue-500 bg-blue-500/10"
      data-testid="task-drop-grid"
      style={{
        left: `calc(${(drop.target.dayIndex / stripLength) * 100}% + 1px)`,
        top: (drop.target.minute / 60) * hourHeight,
        width: `calc(${(1 / stripLength) * 100}% - 3px)`,
      }}
    />
  );
}

export function WeekView({
  birthdays,
  colorOf,
  days,
  events,
  isTaskReadOnly,
  listColorOf,
  onBirthdayClick,
  onEventClick,
  onNavigate,
  onSlotClick,
  onSlotDrag,
  onTaskClick,
  onToggleTask,
  overdue,
  tasks,
  timeZone,
  today: todayIso,
}: {
  birthdays: ReadonlyArray<BirthdayOccurrence>;
  colorOf: ColorLookup;
  days: ReadonlyArray<Temporal.PlainDate>;
  events: ReadonlyArray<EventRecord>;
  isTaskReadOnly: (task: TaskRecord) => boolean;
  listColorOf: (task: TaskRecord) => string | undefined;
  onBirthdayClick: (birthday: BirthdayOccurrence) => void;
  onEventClick: (event: EventRecord) => void;
  onNavigate: (dayCount: number) => void;
  onSlotClick: (date: Temporal.PlainDate, hour: number) => void;
  /** A slot drawn by dragging on empty grid space. */
  onSlotDrag: (
    date: Temporal.PlainDate,
    times: { readonly endTime: string; readonly startTime: string },
  ) => void;
  onTaskClick: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  /** Open tasks due before today; drawn as overdue chips on today's column. */
  overdue: ReadonlyArray<TaskRecord>;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  /** Today's ISO date (rolls at local midnight). */
  today: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const today = Temporal.PlainDate.from(todayIso);

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

  const calendarTasks = useMemo(
    () => partitionCalendarTasks([...tasks, ...overdue], todayIso),
    [tasks, overdue, todayIso],
  );
  const timedTaskLayout = useMemo(() => {
    const byDay = new Map<string, Array<TimedBox>>();
    const byId = new Map<string, TaskRecord>();
    for (const task of calendarTasks.timed) {
      const slot = timedTaskSlot(task);
      if (slot === undefined || task.dueDate === undefined) {
        continue;
      }
      const id = calendarTaskKey(task);
      byId.set(id, task);
      const day = byDay.get(task.dueDate) ?? [];
      day.push({ ...slot, id });
      byDay.set(task.dueDate, day);
    }
    return { byDay, byId };
  }, [calendarTasks.timed]);

  const drag = useEventDrag({
    gridRef,
    hourHeight: HOUR_HEIGHT,
    laneRef,
    onEventClick,
    onTaskClick,
    scrollerRef: scrollRef,
    strip,
  });

  const slot = useSlotDrag({ hourHeight: HOUR_HEIGHT, onCreate: onSlotDrag });

  useWheelPan({
    // Mid-drag day jumps would corrupt the drop target (or the drawn slot's day).
    enabled: drag.preview === null && slot.selection === null,
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

  // Date-only tasks join one-day spans in the all-day lane. Timed reminders
  // are projected into the ordinary day-column overlap layout below.
  const taskSpans = calendarTasks.allDay.flatMap((task) => {
    if (!task.dueDate) {
      return [];
    }
    const index = dayIndexOf(task.dueDate, strip);
    return index === -1
      ? []
      : [{ endDayIndex: index + 1, id: calendarTaskKey(task), startDayIndex: index }];
  });
  // Overdue tasks sit on today's column, whatever their due day.
  const todayIndex = dayIndexOf(todayIso, strip);
  const overdueSpans =
    todayIndex === -1
      ? []
      : calendarTasks.overdue.map((task) => ({
          endDayIndex: todayIndex + 1,
          id: calendarTaskKey(task),
          startDayIndex: todayIndex,
        }));
  const overdueKeys = new Set(calendarTasks.overdue.map(calendarTaskKey));
  const taskById = new Map(
    calendarTasks.allDay.concat(calendarTasks.overdue).map((task) => [calendarTaskKey(task), task]),
  );

  // Birthdays are one-day spans like tasks.
  const birthdaySpans = birthdays.flatMap((birthday) => {
    const index = dayIndexOf(birthday.date, strip);
    return index === -1
      ? []
      : [{ endDayIndex: index + 1, id: birthdayKey(birthday), startDayIndex: index }];
  });
  const birthdayById = new Map(birthdays.map((birthday) => [birthdayKey(birthday), birthday]));

  const { placed: allDayPlaced, rowCount } = layoutAllDayLane(
    overdueSpans.concat(
      taskSpans,
      birthdaySpans,
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
  // Collapsed, the lane caps at MAX_ALL_DAY_ROWS with "+N more" chips; the
  // choice is a device setting, so it survives a relaunch. Expanded by default.
  const preferences = useViewPreferences();
  const { setViewPreferences } = useGuardedMutations();
  const collapsed = preferences?.allDayLaneCollapsed ?? false;
  const capped = collapsed ? capAllDayLane(allDayPlaced, strip.length, MAX_ALL_DAY_ROWS) : null;
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
        birthdayById={birthdayById}
        collapsed={collapsed}
        collapsible={rowCount > MAX_ALL_DAY_ROWS}
        colorOf={colorOf}
        drag={drag}
        isTaskReadOnly={isTaskReadOnly}
        laneRef={laneRef}
        listColorOf={listColorOf}
        moreByDay={capped?.moreByDay ?? []}
        onBirthdayClick={onBirthdayClick}
        onEventClick={onEventClick}
        onSetCollapsed={(value) => void setViewPreferences({ allDayLaneCollapsed: value })}
        onTaskClick={onTaskClick}
        onToggleTask={onToggleTask}
        overdueKeys={overdueKeys}
        placed={capped?.visible ?? allDayPlaced}
        rowCount={capped?.rowCount ?? rowCount}
        scrollbarWidth={scrollbarWidth}
        stripLength={strip.length}
        stripStyle={stripStyle}
        taskById={taskById}
        today={todayIso}
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
              <GridDropIndicator drag={drag} hourHeight={HOUR_HEIGHT} stripLength={strip.length} />
              {strip.map((day) => {
                const iso = day.toString();
                const range = dayRange(day, timeZone);
                const boxes = layoutDayColumn(
                  timedEvents
                    .filter(
                      (event) => event.startUtc < range.endUtc && event.endUtc > range.startUtc,
                    )
                    .map((event) =>
                      timedEventBox(event, `${event.calendarId}:${event.id}`, day, timeZone),
                    )
                    .concat(timedTaskLayout.byDay.get(iso) ?? []),
                );
                const isToday = Temporal.PlainDate.compare(day, today) === 0;
                const drawn =
                  slot.selection && Temporal.PlainDate.compare(slot.selection.day, day) === 0
                    ? slot.selection
                    : null;

                return (
                  <div
                    aria-label={`${day.toLocaleString('en-US', { day: 'numeric', month: 'long', weekday: 'long' })}: press Enter for a new event`}
                    className="relative border-l border-neutral-100 outline-none focus-visible:bg-blue-50/40"
                    key={iso}
                    onClick={(clickEvent) => {
                      // Both flags are consumed, so neither leaks into the next click.
                      const afterMove = drag.consumeSuppressedClick();
                      const afterSlot = slot.consumeSuppressedClick();
                      if (afterMove || afterSlot) {
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
                    onPointerCancel={slot.onPointerCancel}
                    onPointerDown={(pointerEvent) => slot.onPointerDown(day, pointerEvent)}
                    onPointerMove={slot.onPointerMove}
                    onPointerUp={slot.onPointerUp}
                    role="button"
                    // One gradient instead of 24 hour-line divs per column.
                    style={{ backgroundImage: HOUR_LINES }}
                    tabIndex={0}
                  >
                    {boxes.map((box) => {
                      const task = timedTaskLayout.byId.get(box.id);
                      if (task) {
                        return (
                          <TimedTaskBlock
                            box={box}
                            drag={drag}
                            hourHeight={HOUR_HEIGHT}
                            key={box.id}
                            listColor={listColorOf(task)}
                            onTaskClick={onTaskClick}
                            onToggleTask={onToggleTask}
                            readOnly={isTaskReadOnly(task)}
                            task={task}
                          />
                        );
                      }
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

                    {isToday ? <NowIndicator date={day} timeZone={timeZone} /> : null}

                    {drawn ? (
                      <div
                        className="pointer-events-none absolute inset-x-1 z-10 overflow-hidden rounded-md border border-blue-500 bg-blue-500/15 px-1 text-[11px] leading-4 font-medium text-blue-700"
                        data-testid="slot-selection"
                        style={{
                          height: ((drawn.endMinute - drawn.startMinute) / 60) * HOUR_HEIGHT,
                          top: (drawn.startMinute / 60) * HOUR_HEIGHT,
                        }}
                      >
                        {slotLabel(drawn)}
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
