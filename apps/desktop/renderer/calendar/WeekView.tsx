import {
  type DraftOccurrence,
  useShadedWeekdays,
  useUpdateViewPreferences,
  useViewPreferences,
} from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  bufferedDays,
  calendarTaskKey,
  capAllDayLane,
  dayRange,
  type EventRecord,
  expandedAllDayRows,
  foldTaskBacklog,
  formatPlainTime,
  isShadedDay,
  layoutAllDayLane,
  layoutDayColumn,
  MAX_ALL_DAY_ROWS,
  PAN_BUFFER_DAYS,
  partitionCalendarTasks,
  taskCalendarDate,
  taskFoldKey,
  secondaryHourLabels,
  type Slide,
  slideSpan,
  type SlotRange,
  slotTimes,
  type TaskRecord,
  Temporal,
  timedEventBox,
  type TimedBox,
  timedTaskSlot,
  utcMsToPlainDate,
  zoneSlug,
} from '@calendar/core';
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AllDayLane, type FoldEntry, LANE_ROW_PX } from './AllDayLane.tsx';
import { type ColorLookup } from './colors.ts';
import { DayHeaders } from './DayHeaders.tsx';
import { DraftBlock } from './DraftBlock.tsx';
import { NowIndicator } from './NowIndicator.tsx';
import { TimedEventBlock } from './TimedEventBlock.tsx';
import { TimedTaskBlock } from './TimedTaskBlock.tsx';
import { useDropTarget, type useEventDrag } from './useEventDrag.ts';
import { useSlotDrag } from './useSlotDrag.ts';
import { useWheelPan } from './useWheelPan.ts';
import { zoneInk } from './zoneInk.ts';

export const HOUR_HEIGHT = 48;
/**
 * One hairline per hour, as one repeating gradient rather than 24 divs per
 * column, in the theme's border color so the dark grid stays quiet.
 */
const HOUR_LINES = `repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent ${HOUR_HEIGHT}px)`;

/** A draft's id in the lane and column layouts, apart from every stored row's. */
const draftKey = (draft: DraftOccurrence): string => `draft:${draft.key}`;

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
  // A grid block already draws its own preview.
  if (drop === null || drop.from === 'grid' || drop.target.kind !== 'timed') {
    return null;
  }
  return (
    <div
      className="pointer-events-none absolute z-30 h-[22px] rounded border-2 border-dashed border-primary bg-primary/10"
      data-testid="task-drop-grid"
      style={{
        left: `calc(${(drop.target.dayIndex / stripLength) * 100}% + 1px)`,
        top: (drop.target.minute / 60) * hourHeight,
        width: `calc(${(1 / stripLength) * 100}% - 3px)`,
      }}
    />
  );
}

/**
 * The rendered day columns, buffer and a slide's travelled days included —
 * what the drag hook and the strip share. Empty in the month view, which
 * has no day columns (the app owns the hook, so it computes this in every
 * view).
 */
export const useWeekStrip = (days: ReadonlyArray<Temporal.PlainDate>, slide: Slide) =>
  useMemo(() => {
    const first = days[0];
    if (first === undefined) {
      return [];
    }
    const span = slideSpan(first, days.length, slide);
    return bufferedDays(span.first, span.count, PAN_BUFFER_DAYS);
  }, [days, slide]);

export function WeekView({
  birthdays,
  colorOf,
  days,
  drafts,
  drag,
  events,
  gridRef,
  isEventReadOnly,
  isTaskReadOnly,
  laneRef,
  listColorOf,
  onBirthdayClick,
  onDraftClick,
  onEventClick,
  onNavigate,
  onSlideEnd,
  onSlotClick,
  onSlotDrag,
  onTaskClick,
  onToggleTask,
  overdue,
  scrollRef,
  secondaryZones,
  selectedKey,
  slide,
  tasks,
  timeZone,
  today: todayIso,
}: {
  birthdays: ReadonlyArray<BirthdayOccurrence>;
  colorOf: ColorLookup;
  days: ReadonlyArray<Temporal.PlainDate>;
  /** The editor's drafts, one per occurrence in the strip: drawn hatched, never stored. */
  drafts: ReadonlyArray<DraftOccurrence>;
  /** The drag hook, owned by the app so the side panel's rows can drag too. */
  drag: ReturnType<typeof useEventDrag>;
  events: ReadonlyArray<EventRecord>;
  /** The timed strip, the all-day lane and the scroller: the drag hook reads their rects. */
  gridRef: RefObject<HTMLDivElement | null>;
  isEventReadOnly: (event: EventRecord) => boolean;
  isTaskReadOnly: (task: TaskRecord) => boolean;
  laneRef: RefObject<HTMLDivElement | null>;
  listColorOf: (task: TaskRecord) => string | undefined;
  onBirthdayClick: (birthday: BirthdayOccurrence) => void;
  /** A draft block was clicked: the editor focuses that draft — and moves it into the slot, for a candidate. */
  onDraftClick: (draftId: string, slot?: DraftOccurrence['candidate']) => void;
  onEventClick: (event: EventRecord) => void;
  onNavigate: (dayCount: number) => void;
  /** A slide to a picked first day is over: drop the days it travelled across. */
  onSlideEnd: () => void;
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
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The non-primary zones: a second line under each hour label and on tall event blocks. */
  secondaryZones: ReadonlyArray<string>;
  /** `calendarId:id` of the event open in the side panel: its block gets the outline. */
  selectedKey: string | undefined;
  /** The extra days drawn on each side while the view slides to a picked first day. */
  slide: Slide;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  /** Today's ISO date (rolls at local midnight). */
  today: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const today = Temporal.PlainDate.from(todayIso);

  // The pan strip renders buffer columns on both sides of the visible days
  // so horizontal panning reveals fully drawn neighbours (and, during a
  // slide, the days it travels across).
  const strip = useWeekStrip(days, slide);
  // Strips are (buffered/visible)× as wide as their clipped viewport and
  // sit shifted left by the columns before the first visible day;
  // `--pan-x` (set imperatively by useWheelPan on the root) adds the live
  // gesture or slide offset.
  const leading = PAN_BUFFER_DAYS + slide.lead;
  const stripStyle = {
    transform: `translateX(calc(${-(leading / strip.length) * 100}% + var(--pan-x, 0px)))`,
    width: `${(strip.length / days.length) * 100}%`,
  };

  const calendarTasks = useMemo(
    () => partitionCalendarTasks([...tasks, ...overdue], todayIso, timeZone),
    [tasks, overdue, todayIso, timeZone],
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

  const slot = useSlotDrag({ hourHeight: HOUR_HEIGHT, onCreate: onSlotDrag });

  useWheelPan({
    // Mid-drag day jumps would corrupt the drop target (or the drawn slot's day).
    enabled: drag.preview === null && slot.selection === null,
    firstDay: days[0]!,
    onCommitDays: onNavigate,
    onSlideEnd,
    rootRef,
    scrollerRef: scrollRef,
    slide,
    viewportRef,
    visibleDayCount: days.length,
  });

  // The ref object is stable (the app owns it); listing it keeps the lint honest.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 7.5 * HOUR_HEIGHT });
  }, [scrollRef]);

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
  }, [scrollRef]);
  // The view's height (day headers to bottom): an expanded all-day lane
  // takes at most a third of it before it scrolls inside itself.
  const [viewHeight, setViewHeight] = useState(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const measure = () => setViewHeight(root.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const allDayEvents = events.filter((event) => event.isAllDay);
  const timedEvents = events.filter((event) => !event.isAllDay);
  // Drafts share the lane and the day-column layout with events, keyed
  // apart so a draft can never be mistaken for a stored row.
  const draftByKey = new Map(drafts.map((draft) => [draftKey(draft), draft]));
  const timedDrafts = drafts.filter((draft) => !draft.isAllDay);
  const draftSpans = drafts.flatMap((draft) => {
    if (!draft.isAllDay || draft.startDate === undefined || draft.endDate === undefined) {
      return [];
    }
    const first = strip[0]!;
    const start = Math.max(first.until(Temporal.PlainDate.from(draft.startDate)).days, 0);
    const end = Math.min(first.until(Temporal.PlainDate.from(draft.endDate)).days, strip.length);
    return end > start && start < strip.length
      ? [{ endDayIndex: end, id: draftKey(draft), startDayIndex: start }]
      : [];
  });

  // Date-only tasks join one-day spans in the all-day lane. Timed reminders
  // are projected into the ordinary day-column overlap layout below.
  // A late or undated completion sits on the day it was completed.
  const taskSpans = calendarTasks.allDay.flatMap((task) => {
    const index = dayIndexOf(taskCalendarDate(task, todayIso, timeZone), strip);
    return index === -1
      ? []
      : [{ endDayIndex: index + 1, id: calendarTaskKey(task), startDayIndex: index }];
  });
  // Overdue and undated tasks sit on today's column until they are done,
  // each group of two or more folded into one chip.
  const todayIndex = dayIndexOf(todayIso, strip);
  const todayTasks = calendarTasks.overdue.concat(calendarTasks.undated);
  const backlog = foldTaskBacklog(calendarTasks.overdue, calendarTasks.undated);
  const backlogSpans =
    todayIndex === -1
      ? []
      : backlog.map((entry) => ({
          endDayIndex: todayIndex + 1,
          id: entry.kind === 'fold' ? taskFoldKey(entry.fold) : calendarTaskKey(entry.task),
          startDayIndex: todayIndex,
        }));
  const foldById = new Map(
    backlog.flatMap((entry): Array<[string, FoldEntry]> =>
      entry.kind === 'fold' ? [[taskFoldKey(entry.fold), entry]] : [],
    ),
  );
  const overdueKeys = new Set(calendarTasks.overdue.map(calendarTaskKey));
  const taskById = new Map(
    calendarTasks.allDay.concat(todayTasks).map((task) => [calendarTaskKey(task), task]),
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
    backlogSpans.concat(
      taskSpans,
      birthdaySpans,
      draftSpans,
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
  const updateViewPreferences = useUpdateViewPreferences();
  const collapsed = preferences?.allDayLaneCollapsed ?? false;
  const capped = collapsed ? capAllDayLane(allDayPlaced, strip.length, MAX_ALL_DAY_ROWS) : null;
  // The weekend's columns carry their own background through the lane and the grid.
  const shaded = useShadedWeekdays();
  const weekendColumns = strip.flatMap((day, dayIndex) =>
    isShadedDay(shaded, day) ? [{ dayIndex, iso: day.toString() }] : [],
  );
  // Built once per render, not once per column: this component re-renders
  // on every drag pointermove, and the strip is up to 11 columns wide.
  const eventsById = new Map(
    timedEvents.map((event) => [`${event.calendarId}:${event.id}`, event]),
  );
  // The zones stack under each hour, so the gutter only widens enough for
  // the city names over it; the header and the all-day lane carry the same
  // spacer so the three stay column-aligned.
  const gutterClassName = secondaryZones.length === 0 ? 'w-16' : 'w-20';
  // One label per hour for the first *visible* day (not the strip's, which
  // starts PAN_BUFFER_DAYS earlier and can sit on the other side of a DST
  // change): a change inside a multi-day strip can still put another
  // column an hour off, which the exact times on the blocks never are.
  const firstDay = days[0]!;
  const secondaryLabels = useMemo(
    () =>
      secondaryZones.length === 0
        ? null
        : Array.from({ length: 24 }, (_, hour) =>
            secondaryHourLabels(firstDay, hour, timeZone, secondaryZones),
          ),
    [firstDay, timeZone, secondaryZones],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="week-view" ref={rootRef}>
      <DayHeaders
        gutterClassName={gutterClassName}
        scrollbarWidth={scrollbarWidth}
        strip={strip}
        stripStyle={stripStyle}
        today={today}
        zones={secondaryZones.length === 0 ? [] : [timeZone, ...secondaryZones]}
      />

      <AllDayLane
        allDayById={allDayById}
        birthdayById={birthdayById}
        collapsed={collapsed}
        collapsible={rowCount > MAX_ALL_DAY_ROWS}
        colorOf={colorOf}
        draftById={draftByKey}
        drag={drag}
        foldById={foldById}
        gutterClassName={gutterClassName}
        isTaskReadOnly={isTaskReadOnly}
        laneRef={laneRef}
        listColorOf={listColorOf}
        maxRows={expandedAllDayRows(viewHeight, LANE_ROW_PX)}
        moreByDay={capped?.moreByDay ?? []}
        onBirthdayClick={onBirthdayClick}
        onDraftClick={onDraftClick}
        onEventClick={onEventClick}
        onSetCollapsed={(value) => updateViewPreferences({ allDayLaneCollapsed: value })}
        onTaskClick={onTaskClick}
        onToggleTask={onToggleTask}
        overdueKeys={overdueKeys}
        placed={capped?.visible ?? allDayPlaced}
        rowCount={capped?.rowCount ?? rowCount}
        scrollbarWidth={scrollbarWidth}
        selectedKey={selectedKey}
        stripLength={strip.length}
        stripStyle={stripStyle}
        taskById={taskById}
        today={todayIso}
        weekendColumns={weekendColumns}
      />

      {/* Timed grid */}
      <div className="min-h-0 flex-1 overflow-y-scroll" data-testid="week-scroller" ref={scrollRef}>
        <div className="flex" style={{ height: 24 * HOUR_HEIGHT }}>
          {/* Hour gutter */}
          <div className={`relative shrink-0 ${gutterClassName}`}>
            {/* The primary hour sits on its line (half its 12 px line up);
                the other zones hang below it, one line each. */}
            {Array.from({ length: 23 }, (_, index) => (
              <span
                className="absolute right-2 flex -translate-y-1.5 flex-col items-end text-[10px] leading-3 whitespace-nowrap"
                key={index + 1}
                style={{ top: (index + 1) * HOUR_HEIGHT }}
              >
                <span className={secondaryLabels ? zoneInk(0) : 'text-ink-secondary'}>
                  {new Temporal.PlainTime(index + 1).toLocaleString('en-US', {
                    hour: 'numeric',
                  })}
                </span>
                {secondaryLabels ? (
                  <span
                    className="flex flex-col items-end text-[9px]"
                    data-testid={`hour-secondary-${index + 1}`}
                  >
                    {secondaryLabels[index + 1]!.map((label, zoneIndex) => (
                      <span
                        className={zoneInk(zoneIndex + 1)}
                        data-testid={`hour-secondary-${index + 1}-${zoneSlug(secondaryZones[zoneIndex]!)}`}
                        key={secondaryZones[zoneIndex]}
                      >
                        {label}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            ))}
          </div>

          <div className="min-w-0 flex-1 overflow-hidden" ref={viewportRef}>
            <div
              className="relative grid h-full"
              data-testid="week-grid"
              ref={gridRef}
              style={{
                ...stripStyle,
                gridTemplateColumns: `repeat(${strip.length}, 1fr)`,
              }}
            >
              <GridDropIndicator drag={drag} hourHeight={HOUR_HEIGHT} stripLength={strip.length} />
              {strip.map((day, dayIndex) => {
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
                    .concat(
                      timedTaskLayout.byDay.get(iso) ?? [],
                      timedDrafts
                        .filter(
                          (draft) => draft.startUtc < range.endUtc && draft.endUtc > range.startUtc,
                        )
                        .map((draft) => timedEventBox(draft, draftKey(draft), day, timeZone)),
                    ),
                );
                const isToday = Temporal.PlainDate.compare(day, today) === 0;
                const weekend = isShadedDay(shaded, day);
                const drawn =
                  slot.selection && Temporal.PlainDate.compare(slot.selection.day, day) === 0
                    ? slot.selection
                    : null;

                return (
                  <div
                    aria-label={`${day.toLocaleString('en-US', { day: 'numeric', month: 'long', weekday: 'long' })}: press Enter for a new event`}
                    // The hour-line gradient paints over the weekend background.
                    className={`relative border-l border-hairline outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset ${weekend ? 'bg-weekend' : ''}`}
                    data-day={iso}
                    data-weekend={weekend ? 'true' : undefined}
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
                            dayIndex={dayIndex}
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
                      const draft = draftByKey.get(box.id);
                      if (draft) {
                        return (
                          <DraftBlock
                            box={box}
                            hourHeight={HOUR_HEIGHT}
                            key={box.id}
                            occurrence={draft}
                            onClick={onDraftClick}
                            timeZone={timeZone}
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
                          readOnly={isEventReadOnly(event)}
                          secondaryZones={secondaryZones}
                          selected={selectedKey === box.id}
                          timeZone={timeZone}
                        />
                      );
                    })}

                    {isToday ? <NowIndicator date={day} timeZone={timeZone} /> : null}

                    {drawn ? (
                      <div
                        className="pointer-events-none absolute inset-x-1 z-10 overflow-hidden rounded-event bg-selection px-1 text-[11px] leading-4 font-medium text-on-selection ring-2 ring-primary ring-inset"
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
