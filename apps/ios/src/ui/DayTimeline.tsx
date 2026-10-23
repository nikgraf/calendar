import {
  type DraftOccurrence,
  useGuardedMutations,
  useUpdateViewPreferences,
  useViewPreferences,
} from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  bufferedDays,
  calendarTaskKey,
  clampSwipeOffset,
  type EventRecord,
  type FreeSlot,
  groupByDate,
  groupEventsByDay,
  interpolatePages,
  MAX_ALL_DAY_ROWS,
  pageMaxima,
  partitionCalendarTasks,
  taskCalendarDate,
  secondaryHourLabels,
  swipeLag,
  swipeReleaseColumns,
  taskChipLabel,
  type TaskRecord,
  Temporal,
  zoneSlug,
} from '@calendar/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewInstance,
} from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  runOnUI,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { AllDayColumn } from './AllDayColumn.tsx';
import { DayColumn } from './DayColumn.tsx';
import {
  actionText,
  BOX_FONT_SCALE,
  type ThemeColors,
  useStyles,
  useTheme,
  zoneColor,
} from './theme.ts';
import { useEdgeScroll } from './useEdgeScroll.ts';
import { useTaskDrag } from './useTaskDrag.ts';
import { WeekStripCell } from './WeekStrip.tsx';
import { ZoneCities } from './ZoneCities.tsx';
import { ALL_DAY_ROW_HEIGHT, EDGE_INSET, gutterWidth, HOUR_HEIGHT } from './timelineLayout.ts';

/**
 * Writes a shared value from a worklet or callback. Going through a helper
 * keeps the write off a hook-owned local, which the React Compiler treats as
 * immutable.
 */
const setShared = (shared: SharedValue<number>, value: number) => {
  'worklet';
  shared.value = value;
};

/**
 * The horizontal pan that pages the strip by whole columns. Not compiled:
 * its callbacks go to a hook, so the compiler would key its memo on the
 * shared values' `.value`s and read them during every render.
 */
const useDaySwipe = ({
  buffer,
  columnWidth,
  navigatedPx,
  onSwipe,
  panStart,
  panX,
  pending,
  swipedPx,
}: {
  buffer: number;
  columnWidth: number;
  navigatedPx: SharedValue<number>;
  /** A swipe's page change: the columns it moved and the strip's offset after it. */
  onSwipe: (commit: number, px: number) => void;
  panStart: SharedValue<number>;
  panX: SharedValue<number>;
  pending: SharedValue<number>;
  swipedPx: number;
}) => {
  'use no memo';
  // Navigates by `commit` columns now, keeping the strip where it is.
  const navigate = (commit: number) => {
    'worklet';
    setShared(navigatedPx, navigatedPx.value + commit * columnWidth);
    setShared(panX, panX.value + commit * columnWidth);
    runOnJS(onSwipe)(commit, navigatedPx.value);
  };

  return usePanGesture({
    // Only clearly horizontal movement pans; vertical stays with the ScrollView,
    // and event blocks win the arena via their long-press activation.
    activeOffsetX: [-15, 15],
    failOffsetY: [-12, 12],
    onActivate: () => {
      // A second swipe inside the first one's commit animation: the first
      // still counts. Its page is taken now, and this swipe carries on
      // from wherever the strip is.
      cancelAnimation(panX);
      if (pending.value !== 0) {
        const commit = pending.value;
        setShared(pending, 0);
        navigate(commit);
      }
      setShared(panStart, panX.value);
    },
    onDeactivate: (end) => {
      // Snap to the nearest column boundary: whole columns crossed, plus
      // the flick / quarter rule on the remainder. A cancelled pan (the
      // system took the touch) commits nothing.
      const commit = !end.canceled
        ? swipeReleaseColumns(
            panStart.value,
            end.translationX,
            end.velocityX,
            columnWidth,
            buffer,
            swipeLag(navigatedPx.value, swipedPx, columnWidth),
          )
        : 0;
      if (commit === 0) {
        setShared(panX, withTiming(0, { duration: 160 }));
        return;
      }
      setShared(pending, commit);
      setShared(
        panX,
        withTiming(-commit * columnWidth, { duration: 180 }, (finished) => {
          if (finished && pending.value === commit) {
            setShared(pending, 0);
            navigate(commit);
          }
        }),
      );
    },
    onUpdate: (update) => {
      setShared(
        panX,
        clampSwipeOffset(
          panStart.value + update.translationX,
          columnWidth,
          buffer,
          swipeLag(navigatedPx.value, swipedPx, columnWidth),
        ),
      );
    },
  });
};

/**
 * The timed grid for one day, two days or one week: `days` are the visible columns,
 * `buffer` neighbours on each side stay drawn so a swipe reveals content.
 * The strip follows the finger and a release commits the columns crossed —
 * one day at a time in the week view too, which is why the week's day
 * headers live here, panning in lockstep with the columns.
 */
export function DayTimeline({
  birthdays,
  buffer,
  colorOf,
  days,
  drafts,
  events,
  isEventReadOnly,
  isTaskReadOnly,
  listColorOf,
  onBirthdayPress,
  onCreateSlot,
  onDraftPress,
  onEventPress,
  onNavigate,
  onSelectDay,
  onTaskPress,
  onToggleTask,
  overdue,
  revealKey,
  revealMinute,
  secondaryZones,
  selected,
  tasks,
  timeZone,
  today: todayIso,
}: {
  birthdays: ReadonlyArray<BirthdayOccurrence>;
  buffer: number;
  colorOf: (event: EventRecord) => string;
  days: ReadonlyArray<Temporal.PlainDate>;
  /** The open editor's drafts (and free slots beside one), one per occurrence: drawn dashed, never stored. */
  drafts: ReadonlyArray<DraftOccurrence>;
  events: ReadonlyArray<EventRecord>;
  /** An event in a calendar we cannot write opens on tap but never drags. */
  isEventReadOnly: (event: EventRecord) => boolean;
  isTaskReadOnly: (task: TaskRecord) => boolean;
  listColorOf: (task: TaskRecord) => string | undefined;
  onBirthdayPress: (birthday: BirthdayOccurrence) => void;
  /** A slot drawn by holding on empty timeline space. */
  onCreateSlot: (
    date: Temporal.PlainDate,
    times: { readonly endTime: string; readonly startTime: string },
  ) => void;
  /** A draft tapped: the editor focuses it (a free slot: moves the draft there). */
  onDraftPress: (draftId: string, slot?: FreeSlot) => void;
  onEventPress: (event: EventRecord) => void;
  /** A swipe committed: whole days crossed, positive forward in time. */
  onNavigate: (dayCount: number) => void;
  /** A tap on a week-view day header. */
  onSelectDay: (date: Temporal.PlainDate) => void;
  onTaskPress: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  /** Open tasks due before today; drawn as overdue chips in today's column. */
  overdue: ReadonlyArray<TaskRecord>;
  /**
   * The focused draft and its start (id, date, time): the scroll runs
   * again whenever it changes — another draft focused at the same minute
   * on another day still comes into view after the grid was scrolled
   * away — and only then, so paging the calendar leaves the grid alone.
   */
  revealKey?: string | undefined;
  /**
   * The open editor's focused draft starts at this minute of its day: the
   * grid scrolls it near the top, where a half-height editor leaves the
   * calendar in view — with room below midnight while drafts are shown,
   * so an evening draft can come up that far.
   */
  revealMinute?: number | undefined;
  /** The non-primary zones: a line each under every hour label, one joined line on tall event blocks. */
  secondaryZones: ReadonlyArray<string>;
  /** The focused day, ringed in the week header. */
  selected: Temporal.PlainDate;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  /** Today's ISO date (rolls at local midnight). */
  today: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const scrollRef = useAnimatedRef<ScrollView>();
  const { height: windowHeight } = useWindowDimensions();
  const containerRef = useRef<ViewInstance>(null);
  const { updateEvent, updateRecurring } = useGuardedMutations();
  const updateViewPreferences = useUpdateViewPreferences();
  const [pageWidth, setPageWidth] = useState(0);
  // The collapsed lane is a device setting (shared with desktop); expanded by default.
  const collapsed = useViewPreferences()?.allDayLaneCollapsed ?? false;
  const setCollapsed = (value: boolean) => updateViewPreferences({ allDayLaneCollapsed: value });
  const panX = useSharedValue(0);
  // Columns get a divider whenever there is more than one; the dense text
  // treatment only once they are week-narrow (two columns fit the day layout).
  const divided = days.length > 1;
  const compact = days.length > 2;
  const columnWidth = pageWidth / days.length;

  // `panX` is measured from the page navigated to. A swipe navigates on
  // the UI thread first: `navigatedPx` adds up every column it moved, and
  // the swipe hands that sum to React with the page change (`swiped`). The
  // strips sit `swiped.px` along, so the render that draws a swipe's page
  // moves them forward by exactly as much as its new days move them back:
  // no drawn column moves when React catches up, whichever frame its mount
  // lands in. (A UI-thread reset after the render raced the mount, and a
  // frame showed the strip a column off.) `pending` is a released swipe's
  // commit while its animation runs: the page changes when the animation
  // ends, so the re-render never competes with it.
  const navigatedPx = useSharedValue(0);
  const [swiped, setSwiped] = useState({ columns: 0, px: 0 });
  const pending = useSharedValue(0);
  const panStart = useSharedValue(0);
  // The strips' place as React draws them; the swipe's transform moves them from there.
  const stripLeft = swiped.px - buffer * columnWidth;
  // How far the drawn strip sits from its centred place: the task drag's drop geometry.
  const stripOffset = useDerivedValue(() => swiped.px - navigatedPx.value + panX.value);
  const today = Temporal.PlainDate.from(todayIso);
  // The gutter widens with the zones it lists; the header, the lane and the
  // drag geometry all take the same width so the columns stay aligned.
  const gutter = gutterWidth(secondaryZones.length);
  // One label per hour for the first visible day: a DST change inside a
  // multi-day strip can put another column an hour off, which the exact
  // times on the blocks themselves never are.
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
  // Primary first: the cities over the gutter, with one zone none at all.
  const zoneCities = secondaryZones.length === 0 ? null : [timeZone, ...secondaryZones];

  const commitChange = (
    event: EventRecord,
    changes: { endUtc?: number; startUtc?: number },
  ): Promise<void> => {
    if (event.recurringEventId) {
      return updateRecurring({
        accountId: event.accountId,
        calendarId: event.calendarId,
        changes,
        masterId: event.recurringEventId,
        originalStartUtc: event.originalStartUtc ?? event.startUtc,
        scope: 'instance',
      });
    }
    return updateEvent({
      accountId: event.accountId,
      calendarId: event.calendarId,
      changes,
      eventId: event.id,
    });
  };

  const strip = useMemo(() => bufferedDays(days[0]!, days.length, buffer), [days, buffer]);
  // One pass over the window's events, not one filter per column.
  const byDay = useMemo(() => groupEventsByDay(events, strip, timeZone), [events, strip, timeZone]);
  const draftsByDay = useMemo(
    () => groupEventsByDay(drafts, strip, timeZone),
    [drafts, strip, timeZone],
  );
  const calendarTasks = useMemo(
    () => partitionCalendarTasks([...tasks, ...overdue], todayIso, timeZone),
    [tasks, overdue, todayIso, timeZone],
  );
  // Overdue and undated chips lead today's column until they are done; a
  // late or undated completion sits on the day it was completed.
  const tasksByDay = useMemo(() => {
    const byDay = new Map(
      groupByDate(calendarTasks.allDay, (task) => taskCalendarDate(task, todayIso, timeZone)),
    );
    const todayTasks = calendarTasks.overdue.concat(calendarTasks.undated);
    if (todayTasks.length > 0) {
      byDay.set(todayIso, todayTasks.concat(byDay.get(todayIso) ?? []));
    }
    return byDay;
  }, [calendarTasks, todayIso, timeZone]);
  const overdueKeys = useMemo(
    () => new Set(calendarTasks.overdue.map(calendarTaskKey)),
    [calendarTasks],
  );
  const timedTasksByDay = useMemo(
    () => groupByDate(calendarTasks.timed, (task) => task.dueDate),
    [calendarTasks],
  );
  const birthdaysByDay = useMemo(
    () => groupByDate(birthdays, (birthday) => birthday.date),
    [birthdays],
  );

  // The lane fits the visible page's busiest day. Mid-swipe it blends
  // toward the page coming in, so the grid below moves with the finger
  // and is already in place when the swipe lands. (Sized to every drawn
  // day instead, the lane changed whenever a neighbour entered or left
  // the strip, and the grid jumped a row after the swipe had settled.)
  const pageRows = useMemo(
    () =>
      pageMaxima(
        strip.map((day) => {
          const iso = day.toString();
          return (
            (tasksByDay.get(iso)?.length ?? 0) +
            (birthdaysByDay.get(iso)?.length ?? 0) +
            (byDay.get(iso) ?? []).filter((event) => event.isAllDay).length +
            (draftsByDay.get(iso) ?? []).filter((draft) => draft.isAllDay).length
          );
        }),
        days.length,
      ),
    [strip, tasksByDay, birthdaysByDay, byDay, draftsByDay, days.length],
  );
  const laneHeightFor = (rows: number) =>
    Math.max(collapsed ? Math.min(rows, MAX_ALL_DAY_ROWS) : rows, 1) * ALL_DAY_ROW_HEIGHT + 4;
  const pageHeights = pageRows.map(laneHeightFor);
  const rowsNeeded = pageRows[buffer] ?? 0;
  const laneHeight = laneHeightFor(rowsNeeded);
  const maxChips = collapsed ? MAX_ALL_DAY_ROWS : Number.POSITIVE_INFINITY;

  useEffect(() => {
    scrollRef.current?.scrollTo({ animated: false, y: 7.5 * HOUR_HEIGHT });
  }, [scrollRef]);
  // A draft the editor focused (made, moved, paged to): its start an hour
  // below the top of the grid.
  useEffect(() => {
    if (revealMinute !== undefined) {
      scrollRef.current?.scrollTo({
        animated: true,
        y: Math.max(0, (revealMinute / 60 - 1) * HOUR_HEIGHT),
      });
    }
  }, [revealKey, revealMinute, scrollRef]);

  // Geometry the task drag judges drops against; measured, never rendered.
  // (The chip drags and this swipe are exclusive in the gesture arena: a
  // long press activates the chip's pan and cancels a swipe that has not
  // moved its 15 points yet.)
  const containerX = useSharedValue(0);
  const containerY = useSharedValue(0);
  const containerHeight = useSharedValue(0);
  const laneTop = useSharedValue(0);
  // Kept on the UI thread: a drag reads it in the same frame the edge
  // scroll moved the grid.
  const scrollY = useSharedValue(7.5 * HOUR_HEIGHT);
  const onScroll = useAnimatedScrollHandler((scroll) => {
    setShared(scrollY, scroll.contentOffset.y);
  });
  const contentHeight = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const edgeScroll = useEdgeScroll({
    containerHeight,
    containerY,
    contentHeight,
    laneHeight,
    laneTop,
    scrollRef,
    scrollY,
    viewportHeight,
  });
  const taskDrag = useTaskDrag({
    buffer,
    columnWidth,
    containerHeight,
    containerX,
    containerY,
    edge: edgeScroll,
    gutterWidth: gutter,
    laneHeight,
    laneTop,
    scrollY,
    strip,
    stripOffset,
  });
  const measureContainer = () => {
    containerRef.current?.measureInWindow((x, y, _width, height) => {
      setShared(containerX, x);
      setShared(containerY, y);
      setShared(containerHeight, height);
    });
  };

  // A change from outside (Today, chevrons, a tapped day, a view switch)
  // needs nothing from the strips, which React places with the new days;
  // it only stops a swipe still settling, whose commit would otherwise
  // move on from the new page. A swipe's own page change moved the first
  // day by exactly the columns it reported.
  const firstIso = days[0]!.toString();
  const rendered = useRef({ columns: swiped.columns, count: days.length, first: days[0]! });
  useLayoutEffect(() => {
    const previous = rendered.current;
    const first = Temporal.PlainDate.from(firstIso);
    rendered.current = { columns: swiped.columns, count: days.length, first };
    if (
      previous.count !== days.length ||
      previous.first.until(first).days !== swiped.columns - previous.columns
    ) {
      runOnUI(() => {
        'worklet';
        cancelAnimation(panX);
        setShared(pending, 0);
        setShared(panX, 0);
      })();
    }
  }, [firstIso, days.length, swiped.columns, panX, pending]);

  const reportSwipe = (commit: number, px: number) => {
    setSwiped((current) => ({ columns: current.columns + commit, px }));
    onNavigate(commit);
  };
  const swipe = useDaySwipe({
    buffer,
    columnWidth,
    navigatedPx,
    onSwipe: reportSwipe,
    panStart,
    panX,
    pending,
    swipedPx: swiped.px,
  });

  const stripStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: panX.value - navigatedPx.value }],
  }));
  // The lane's height for the page at the viewport's left edge: an index
  // into `pageHeights`, fractional mid-swipe.
  const laneStyle = useAnimatedStyle(() => ({
    height: interpolatePages(
      pageHeights,
      columnWidth > 0 ? (navigatedPx.value - panX.value - stripLeft) / columnWidth : buffer,
    ),
  }));

  return (
    <View
      onLayout={measureContainer}
      ref={containerRef}
      style={styles.container}
      testID="day-timeline"
    >
      {days.length > 1 ? (
        <View style={styles.weekHeader}>
          {zoneCities ? (
            <ZoneCities width={gutter} zones={zoneCities} />
          ) : (
            <View style={{ width: gutter }} />
          )}
          <View style={styles.stripViewport}>
            <Animated.View style={[styles.strip, { left: stripLeft }, stripStyle]}>
              {strip.map((day) => (
                <WeekStripCell
                  day={day}
                  isSelected={Temporal.PlainDate.compare(day, selected) === 0}
                  isToday={Temporal.PlainDate.compare(day, today) === 0}
                  key={day.toString()}
                  onPress={() => onSelectDay(day)}
                  width={columnWidth}
                />
              ))}
            </Animated.View>
          </View>
        </View>
      ) : zoneCities ? (
        // The day view has no header over its gutter (the week strip above
        // spans the screen), so the cities get a row of their own.
        <View style={styles.zoneHeader}>
          <ZoneCities width={gutter} zones={zoneCities} />
        </View>
      ) : null}
      <Animated.View
        onLayout={(layout) => setShared(laneTop, layout.nativeEvent.layout.y)}
        style={[styles.allDayLane, laneStyle]}
      >
        <View style={{ width: gutter }}>
          {!collapsed && rowsNeeded > MAX_ALL_DAY_ROWS ? (
            <Pressable
              accessibilityLabel="Collapse the all-day lane"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setCollapsed(true)}
              testID="all-day-less"
            >
              <Text
                maxFontSizeMultiplier={BOX_FONT_SCALE}
                style={[styles.gutterLabel, styles.gutterAction]}
              >
                less
              </Text>
            </Pressable>
          ) : (
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.gutterLabel}>
              all-day
            </Text>
          )}
        </View>
        <View style={styles.stripViewport}>
          <Animated.View style={[styles.strip, { left: stripLeft }, stripStyle]}>
            <Animated.View
              pointerEvents="none"
              style={[styles.laneIndicator, { width: columnWidth }, taskDrag.laneIndicatorStyle]}
            />
            {strip.map((day) => {
              const iso = day.toString();
              return (
                <AllDayColumn
                  birthdays={birthdaysByDay.get(iso) ?? []}
                  colorOf={colorOf}
                  compact={compact}
                  drafts={(draftsByDay.get(iso) ?? []).filter((draft) => draft.isAllDay)}
                  draggingKey={taskDrag.dragging?.key ?? null}
                  events={(byDay.get(iso) ?? []).filter((event) => event.isAllDay)}
                  isTaskReadOnly={isTaskReadOnly}
                  key={iso}
                  listColorOf={listColorOf}
                  maxChips={maxChips}
                  onBirthdayPress={onBirthdayPress}
                  onDraftPress={(draftId) => onDraftPress(draftId)}
                  onEventPress={onEventPress}
                  onShowMore={() => setCollapsed(false)}
                  onTaskPress={onTaskPress}
                  onToggleTask={onToggleTask}
                  overdueKeys={overdueKeys}
                  taskDrag={taskDrag}
                  tasks={tasksByDay.get(iso) ?? []}
                  today={todayIso}
                  width={columnWidth}
                />
              );
            })}
          </Animated.View>
        </View>
      </Animated.View>

      <GestureDetector gesture={swipe}>
        <Animated.ScrollView
          contentContainerStyle={
            drafts.length > 0 ? { paddingBottom: windowHeight / 2 } : undefined
          }
          onContentSizeChange={(_width, height) => setShared(contentHeight, height)}
          onLayout={(layout) => setShared(viewportHeight, layout.nativeEvent.layout.height)}
          onScroll={onScroll}
          ref={scrollRef}
          scrollEventThrottle={16}
          style={styles.scroll}
        >
          <View style={{ height: 24 * HOUR_HEIGHT }}>
            {Array.from({ length: 24 }, (_, hour) => (
              <View key={hour} style={[styles.hourRow, { top: hour * HOUR_HEIGHT }]}>
                {/* The primary hour sits on its line; the other zones hang
                    below it, one line each, in their header's shades. */}
                <View style={[styles.hourLabels, { width: gutter - 12 }]}>
                  <Text
                    maxFontSizeMultiplier={BOX_FONT_SCALE}
                    style={[styles.hourLabel, secondaryLabels && { color: zoneColor(colors, 0) }]}
                  >
                    {hour === 0
                      ? ''
                      : new Temporal.PlainTime(hour).toLocaleString('en-US', {
                          hour: 'numeric',
                        })}
                  </Text>
                  {secondaryLabels && hour > 0 ? (
                    <View testID={`hour-secondary-${hour}`}>
                      {secondaryLabels[hour]!.map((label, zoneIndex) => (
                        <Text
                          key={secondaryZones[zoneIndex]}
                          maxFontSizeMultiplier={BOX_FONT_SCALE}
                          numberOfLines={1}
                          style={[
                            styles.hourLabelSecondary,
                            { color: zoneColor(colors, zoneIndex + 1) },
                          ]}
                          testID={`hour-secondary-${hour}-${zoneSlug(secondaryZones[zoneIndex]!)}`}
                        >
                          {label}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                </View>
                <View style={styles.hourLine} />
              </View>
            ))}

            <View
              onLayout={(layout) => setPageWidth(layout.nativeEvent.layout.width)}
              style={[styles.eventsArea, { left: gutter }]}
            >
              <Animated.View style={[styles.strip, { left: stripLeft }, stripStyle]}>
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.gridIndicator,
                    { width: columnWidth },
                    taskDrag.gridIndicatorStyle,
                  ]}
                />
                {strip.map((day) => {
                  const iso = day.toString();
                  return (
                    <DayColumn
                      colorOf={colorOf}
                      compact={compact}
                      date={day}
                      divided={divided}
                      drafts={(draftsByDay.get(iso) ?? []).filter((draft) => !draft.isAllDay)}
                      draggingKey={taskDrag.dragging?.key ?? null}
                      edgeScroll={edgeScroll}
                      events={(byDay.get(iso) ?? []).filter((event) => !event.isAllDay)}
                      isEventReadOnly={isEventReadOnly}
                      isTaskReadOnly={isTaskReadOnly}
                      isToday={Temporal.PlainDate.compare(day, today) === 0}
                      key={iso}
                      listColorOf={listColorOf}
                      onCommit={commitChange}
                      onCreateSlot={onCreateSlot}
                      onDraftPress={onDraftPress}
                      onEventPress={onEventPress}
                      onTaskPress={onTaskPress}
                      onToggleTask={onToggleTask}
                      secondaryZones={secondaryZones}
                      taskDrag={taskDrag}
                      timedTasks={timedTasksByDay.get(iso) ?? []}
                      timeZone={timeZone}
                      width={columnWidth}
                    />
                  );
                })}
              </Animated.View>
            </View>
          </View>
        </Animated.ScrollView>
      </GestureDetector>

      {taskDrag.dragging ? (
        <Animated.View pointerEvents="none" style={[styles.ghost, taskDrag.ghostStyle]}>
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} numberOfLines={1} style={styles.ghostText}>
            {taskChipLabel(taskDrag.dragging.task)}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    allDayLane: {
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
    },
    container: {
      flex: 1,
    },
    eventsArea: {
      bottom: 0,
      overflow: 'hidden',
      position: 'absolute',
      right: EDGE_INSET,
      top: 0,
    },
    ghost: {
      backgroundColor: colors.fill,
      borderColor: colors.border,
      borderRadius: 5,
      borderWidth: StyleSheet.hairlineWidth,
      height: 22,
      justifyContent: 'center',
      left: 0,
      paddingHorizontal: 6,
      position: 'absolute',
      shadowColor: '#000000',
      shadowOffset: { height: 4, width: 0 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      top: 0,
      zIndex: 30,
    },
    ghostText: {
      color: colors.text,
      fontSize: 12,
      fontWeight: '500',
    },
    gridIndicator: {
      backgroundColor: colors.selection,
      borderColor: colors.primary,
      borderRadius: 5,
      borderStyle: 'dashed',
      borderWidth: 1.5,
      height: 22,
      left: 0,
      position: 'absolute',
      top: 0,
      zIndex: 20,
    },
    gutterAction: actionText(colors),
    gutterLabel: {
      color: colors['text-secondary'],
      fontSize: 10,
      paddingRight: 12,
      paddingTop: 6,
      textAlign: 'right',
    },
    hourLabel: {
      color: colors['text-secondary'],
      fontSize: 10,
      textAlign: 'right',
    },
    hourLabels: {
      transform: [{ translateY: -6 }],
    },
    hourLabelSecondary: {
      fontSize: 8,
      textAlign: 'right',
    },
    hourLine: {
      backgroundColor: colors.border,
      flex: 1,
      height: StyleSheet.hairlineWidth,
      marginLeft: 6,
    },
    hourRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      left: 0,
      position: 'absolute',
      right: 0,
    },
    laneIndicator: {
      backgroundColor: colors.selection,
      borderColor: colors.primary,
      borderRadius: 5,
      borderWidth: 1,
      bottom: 0,
      left: 0,
      position: 'absolute',
      top: 0,
    },
    scroll: {
      flex: 1,
    },
    strip: {
      flexDirection: 'row',
    },
    stripViewport: {
      flex: 1,
      marginRight: EDGE_INSET,
      overflow: 'hidden',
    },
    weekHeader: {
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      paddingBottom: 6,
    },
    zoneHeader: {
      flexDirection: 'row',
      paddingVertical: 4,
    },
  });
