import {
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
  groupByDate,
  groupEventsByDay,
  MAX_ALL_DAY_ROWS,
  partitionCalendarTasks,
  taskCalendarDate,
  secondaryHourLabels,
  swipeLagAfterRender,
  swipeReleaseColumns,
  taskChipLabel,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { AllDayColumn } from './AllDayColumn.tsx';
import { DayColumn } from './DayColumn.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';
import { useTaskDrag } from './useTaskDrag.ts';
import { WeekStripCell } from './WeekStrip.tsx';
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
  events,
  isEventReadOnly,
  isTaskReadOnly,
  listColorOf,
  onBirthdayPress,
  onCreateSlot,
  onEventPress,
  onNavigate,
  onSelectDay,
  onTaskPress,
  onToggleTask,
  overdue,
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
  onEventPress: (event: EventRecord) => void;
  /** A swipe committed: whole days crossed, positive forward in time. */
  onNavigate: (dayCount: number) => void;
  /** A tap on a week-view day header. */
  onSelectDay: (date: Temporal.PlainDate) => void;
  onTaskPress: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  /** Open tasks due before today; drawn as overdue chips in today's column. */
  overdue: ReadonlyArray<TaskRecord>;
  /** The non-primary zones: a second line under each hour label and on tall event blocks. */
  secondaryZones: ReadonlyArray<string>;
  /** The focused day, ringed in the week header. */
  selected: Temporal.PlainDate;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  /** Today's ISO date (rolls at local midnight). */
  today: string;
}) {
  const styles = useStyles(makeStyles);
  const scrollRef = useRef<ScrollView>(null);
  const containerRef = useRef<View>(null);
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

  // `panX` is measured from the page navigated to; the strip is drawn for
  // the page React last rendered, `lag` columns behind it while a
  // navigation is on its way to the screen. `pending` is a released
  // swipe's commit while its animation runs: the page changes when the
  // animation ends, so the re-render never competes with it.
  const lag = useSharedValue(0);
  const pending = useSharedValue(0);
  const panStart = useSharedValue(0);
  // Where the drawn strip sits: its transform and the task drag's drop geometry.
  const stripOffset = useDerivedValue(() => panX.value - lag.value * columnWidth);
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

  // The lane sizes itself to the busiest drawn day (neighbours included)
  // so a swipe never shifts the grid; only a committed page change can.
  const rowsNeeded = Math.max(
    0,
    ...strip.map((day) => {
      const iso = day.toString();
      return (
        (tasksByDay.get(iso)?.length ?? 0) +
        (birthdaysByDay.get(iso)?.length ?? 0) +
        (byDay.get(iso) ?? []).filter((event) => event.isAllDay).length
      );
    }),
  );
  const capped = collapsed && rowsNeeded > MAX_ALL_DAY_ROWS;
  const laneHeight = Math.max(capped ? MAX_ALL_DAY_ROWS : rowsNeeded, 1) * ALL_DAY_ROW_HEIGHT + 4;
  const maxChips = capped ? MAX_ALL_DAY_ROWS : Number.POSITIVE_INFINITY;

  useEffect(() => {
    scrollRef.current?.scrollTo({ animated: false, y: 7.5 * HOUR_HEIGHT });
  }, []);

  // Geometry the task drag judges drops against; measured, never rendered.
  // (The chip drags and this swipe are exclusive in the gesture arena: a
  // long press activates the chip's pan and cancels a swipe that has not
  // moved its 15 points yet.)
  const containerX = useSharedValue(0);
  const containerY = useSharedValue(0);
  const containerHeight = useSharedValue(0);
  const laneTop = useSharedValue(0);
  const scrollY = useSharedValue(7.5 * HOUR_HEIGHT);
  const taskDrag = useTaskDrag({
    buffer,
    columnWidth,
    containerHeight,
    containerX,
    containerY,
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

  // A navigation the strip has rendered: take it off the lag in the same
  // pass that drew it — resetting before the render would briefly show the
  // wrong day. A change from outside (Today, chevrons, a tapped day, a
  // view switch) starts the strip centred.
  const firstIso = days[0]!.toString();
  const rendered = useRef({ count: days.length, first: days[0]! });
  useLayoutEffect(() => {
    const previous = rendered.current;
    const first = Temporal.PlainDate.from(firstIso);
    rendered.current = { count: days.length, first };
    const delta = previous.count === days.length ? previous.first.until(first).days : null;
    runOnUI((change: number | null) => {
      'worklet';
      const left = change === null ? null : swipeLagAfterRender(lag.value, change);
      if (left === null) {
        cancelAnimation(panX);
        setShared(pending, 0);
        setShared(lag, 0);
        setShared(panX, 0);
      } else {
        setShared(lag, left);
      }
    })(delta);
  }, [firstIso, days.length, lag, panX, pending]);

  // Navigates by `commit` columns now, keeping the strip where it is.
  const navigate = (commit: number) => {
    'worklet';
    setShared(lag, lag.value + commit);
    setShared(panX, panX.value + commit * columnWidth);
    runOnJS(onNavigate)(commit);
  };

  const swipe = Gesture.Pan()
    // Only clearly horizontal movement pans; vertical stays with the ScrollView,
    // and event blocks win the arena via their long-press activation.
    .activeOffsetX([-15, 15])
    .failOffsetY([-12, 12])
    .onStart(() => {
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
    })
    .onUpdate((update) => {
      setShared(
        panX,
        clampSwipeOffset(panStart.value + update.translationX, columnWidth, buffer, lag.value),
      );
    })
    .onEnd((end, success) => {
      // Snap to the nearest column boundary: whole columns crossed, plus
      // the flick / quarter rule on the remainder. A cancelled pan (the
      // system took the touch) commits nothing.
      const commit = success
        ? swipeReleaseColumns(
            panStart.value,
            end.translationX,
            end.velocityX,
            columnWidth,
            buffer,
            lag.value,
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
    });

  const stripStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -buffer * columnWidth + stripOffset.value }],
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
          <View style={{ width: gutter }} />
          <View style={styles.stripViewport}>
            <Animated.View style={[styles.strip, stripStyle]}>
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
      ) : null}
      <View
        onLayout={(layout) => setShared(laneTop, layout.nativeEvent.layout.y)}
        style={[styles.allDayLane, { height: laneHeight }]}
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
          <Animated.View style={[styles.strip, stripStyle]}>
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
                  draggingKey={taskDrag.dragging?.key ?? null}
                  events={(byDay.get(iso) ?? []).filter((event) => event.isAllDay)}
                  isTaskReadOnly={isTaskReadOnly}
                  key={iso}
                  listColorOf={listColorOf}
                  maxChips={maxChips}
                  onBirthdayPress={onBirthdayPress}
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
      </View>

      <GestureDetector gesture={swipe}>
        <ScrollView
          onScroll={(scroll) => setShared(scrollY, scroll.nativeEvent.contentOffset.y)}
          ref={scrollRef}
          scrollEventThrottle={16}
          style={styles.scroll}
        >
          <View style={{ height: 24 * HOUR_HEIGHT }}>
            {Array.from({ length: 24 }, (_, hour) => (
              <View key={hour} style={[styles.hourRow, { top: hour * HOUR_HEIGHT }]}>
                <View style={[styles.hourLabels, { width: gutter - 12 }]}>
                  <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.hourLabel}>
                    {hour === 0
                      ? ''
                      : new Temporal.PlainTime(hour).toLocaleString('en-US', {
                          hour: 'numeric',
                        })}
                  </Text>
                  {secondaryLabels ? (
                    <Text
                      maxFontSizeMultiplier={BOX_FONT_SCALE}
                      numberOfLines={1}
                      style={styles.hourLabelSecondary}
                      testID={`hour-secondary-${hour}`}
                    >
                      {hour === 0 ? '' : secondaryLabels[hour]}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.hourLine} />
              </View>
            ))}

            <View
              onLayout={(layout) => setPageWidth(layout.nativeEvent.layout.width)}
              style={[styles.eventsArea, { left: gutter }]}
            >
              <Animated.View style={[styles.strip, stripStyle]}>
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
                      draggingKey={taskDrag.dragging?.key ?? null}
                      events={(byDay.get(iso) ?? []).filter((event) => !event.isAllDay)}
                      isEventReadOnly={isEventReadOnly}
                      isTaskReadOnly={isTaskReadOnly}
                      isToday={Temporal.PlainDate.compare(day, today) === 0}
                      key={iso}
                      listColorOf={listColorOf}
                      onCommit={commitChange}
                      onCreateSlot={onCreateSlot}
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
        </ScrollView>
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
    gutterAction: {
      color: colors.primary,
    },
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
      color: colors['text-secondary'],
      fontSize: 8,
      opacity: 0.8,
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
  });
