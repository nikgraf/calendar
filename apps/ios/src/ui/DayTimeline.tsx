import { useGuardedMutations, useViewPreferences } from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  bufferedDays,
  calendarTaskKey,
  type EventRecord,
  groupByDate,
  groupEventsByDay,
  MAX_ALL_DAY_ROWS,
  partitionCalendarTasks,
  swipeCommitColumns,
  taskChipLabel,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { AllDayColumn } from './AllDayColumn.tsx';
import { DayColumn } from './DayColumn.tsx';
import { palette } from './theme.ts';
import { useTaskDrag } from './useTaskDrag.ts';
import { WeekStripCell } from './WeekStrip.tsx';
import { ALL_DAY_ROW_HEIGHT, EDGE_INSET, GUTTER_WIDTH, HOUR_HEIGHT } from './timelineLayout.ts';

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
 * The timed grid for one day or one week: `days` are the visible columns,
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
  /** The focused day, ringed in the week header. */
  selected: Temporal.PlainDate;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  /** Today's ISO date (rolls at local midnight). */
  today: string;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const containerRef = useRef<View>(null);
  const { setViewPreferences, updateEvent, updateRecurring } = useGuardedMutations();
  const [pageWidth, setPageWidth] = useState(0);
  // The collapsed lane is a device setting (shared with desktop); expanded by default.
  const collapsed = useViewPreferences()?.allDayLaneCollapsed ?? false;
  const setCollapsed = (value: boolean) => void setViewPreferences({ allDayLaneCollapsed: value });
  const panX = useSharedValue(0);
  const compact = days.length > 1;
  const columnWidth = pageWidth / days.length;
  const today = Temporal.PlainDate.from(todayIso);

  const commitChange = (event: EventRecord, changes: { endUtc?: number; startUtc?: number }) => {
    if (event.recurringEventId) {
      void updateRecurring({
        accountId: event.accountId,
        calendarId: event.calendarId,
        changes,
        masterId: event.recurringEventId,
        originalStartUtc: event.originalStartUtc ?? event.startUtc,
        scope: 'instance',
      });
    } else {
      void updateEvent({
        accountId: event.accountId,
        calendarId: event.calendarId,
        changes,
        eventId: event.id,
      });
    }
  };

  const strip = useMemo(() => bufferedDays(days[0]!, days.length, buffer), [days, buffer]);
  // One pass over the window's events, not one filter per column.
  const byDay = useMemo(() => groupEventsByDay(events, strip, timeZone), [events, strip, timeZone]);
  const calendarTasks = useMemo(
    () => partitionCalendarTasks([...tasks, ...overdue], todayIso),
    [tasks, overdue, todayIso],
  );
  // Overdue chips lead today's column, whatever their own due day.
  const tasksByDay = useMemo(() => {
    const byDay = new Map(groupByDate(calendarTasks.allDay, (task) => task.dueDate));
    if (calendarTasks.overdue.length > 0) {
      byDay.set(todayIso, calendarTasks.overdue.concat(byDay.get(todayIso) ?? []));
    }
    return byDay;
  }, [calendarTasks, todayIso]);
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
    laneHeight,
    laneTop,
    panX,
    scrollY,
    strip,
  });
  const measureContainer = () => {
    containerRef.current?.measureInWindow((x, y, _width, height) => {
      setShared(containerX, x);
      setShared(containerY, y);
      setShared(containerHeight, height);
    });
  };

  // Re-centre once the new page has rendered — resetting in the same tick as
  // the state update would briefly show the wrong day. Also clears a stray
  // offset when the days change from outside (Today, chevrons, week strip).
  const firstIso = days[0]!.toString();
  useLayoutEffect(() => {
    setShared(panX, 0);
  }, [firstIso, panX]);

  // The finger can drag as far as there are drawn columns: the buffer.
  const maxPan = buffer * columnWidth;
  const swipe = Gesture.Pan()
    // Only clearly horizontal movement pans; vertical stays with the ScrollView,
    // and event blocks win the arena via their long-press activation.
    .activeOffsetX([-15, 15])
    .failOffsetY([-12, 12])
    .onUpdate((update) => {
      setShared(panX, Math.max(-maxPan, Math.min(maxPan, update.translationX)));
    })
    .onEnd((end) => {
      if (columnWidth === 0) {
        setShared(panX, withTiming(0, { duration: 160 }));
        return;
      }
      // Snap to the nearest column boundary: whole columns crossed, plus
      // the flick / quarter rule on the remainder.
      const commit = swipeCommitColumns(end.translationX, end.velocityX, columnWidth, buffer);
      if (commit !== 0) {
        setShared(
          panX,
          withTiming(-commit * columnWidth, { duration: 180 }, (finished) => {
            if (finished) {
              runOnJS(onNavigate)(commit);
            }
          }),
        );
      } else {
        setShared(panX, withTiming(0, { duration: 160 }));
      }
    });

  const stripStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -buffer * columnWidth + panX.value }],
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
          <View style={styles.gutterSpacer} />
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
        <View style={styles.gutterSpacer}>
          {!collapsed && rowsNeeded > MAX_ALL_DAY_ROWS ? (
            <Pressable
              accessibilityLabel="Collapse the all-day lane"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setCollapsed(true)}
              testID="all-day-less"
            >
              <Text style={[styles.gutterLabel, styles.gutterAction]}>less</Text>
            </Pressable>
          ) : (
            <Text style={styles.gutterLabel}>all-day</Text>
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
                <Text style={styles.hourLabel}>
                  {hour === 0
                    ? ''
                    : new Temporal.PlainTime(hour).toLocaleString('en-US', {
                        hour: 'numeric',
                      })}
                </Text>
                <View style={styles.hourLine} />
              </View>
            ))}

            <View
              onLayout={(layout) => setPageWidth(layout.nativeEvent.layout.width)}
              style={styles.eventsArea}
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
                      draggingKey={taskDrag.dragging?.key ?? null}
                      events={(byDay.get(iso) ?? []).filter((event) => !event.isAllDay)}
                      isTaskReadOnly={isTaskReadOnly}
                      isToday={Temporal.PlainDate.compare(day, today) === 0}
                      key={iso}
                      listColorOf={listColorOf}
                      onCommit={commitChange}
                      onCreateSlot={onCreateSlot}
                      onEventPress={onEventPress}
                      onTaskPress={onTaskPress}
                      onToggleTask={onToggleTask}
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
          <Text numberOfLines={1} style={styles.ghostText}>
            {taskChipLabel(taskDrag.dragging.task)}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  allDayLane: {
    borderBottomColor: palette.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
  },
  container: {
    flex: 1,
  },
  eventsArea: {
    bottom: 0,
    left: GUTTER_WIDTH,
    overflow: 'hidden',
    position: 'absolute',
    right: EDGE_INSET,
    top: 0,
  },
  ghost: {
    backgroundColor: '#f5f5f5',
    borderColor: '#d4d4d4',
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
    color: palette.text,
    fontSize: 12,
    fontWeight: '500',
  },
  gridIndicator: {
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
    borderColor: '#3b82f6',
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
    color: '#2563eb',
  },
  gutterLabel: {
    color: palette.textFaint,
    fontSize: 10,
    paddingRight: 12,
    paddingTop: 6,
    textAlign: 'right',
  },
  gutterSpacer: {
    width: GUTTER_WIDTH,
  },
  hourLabel: {
    color: palette.textFaint,
    fontSize: 10,
    textAlign: 'right',
    transform: [{ translateY: -6 }],
    width: 44,
  },
  hourLine: {
    backgroundColor: palette.gridLine,
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
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
    borderColor: '#60a5fa',
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
    borderBottomColor: palette.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingBottom: 6,
  },
});
