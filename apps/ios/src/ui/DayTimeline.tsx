import { useGuardedMutations, useNow } from '@calendar/app-state';
import {
  bufferedDays,
  dayRange,
  type EventRecord,
  formatClockTime,
  groupEventsByDay,
  layoutDayColumn,
  moveEventTimes,
  resizeEventEnd,
  swipeSnapDecision,
  taskChipLabel,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type DimensionValue } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { chipTextColor, palette } from './theme.ts';
import {
  ALL_DAY_ROW_HEIGHT,
  EDGE_INSET,
  GUTTER_WIDTH,
  HOUR_HEIGHT,
  MAX_ALL_DAY_ROWS,
  pxToMinutes,
  SNAP_PX,
} from './timelineLayout.ts';

/**
 * Writes a shared value from a worklet or callback. Going through a helper
 * keeps the write off a hook-owned local, which the React Compiler treats as
 * immutable.
 */
const setShared = (shared: SharedValue<number>, value: number) => {
  'worklet';
  shared.value = value;
};

function DraggableEventBlock({
  color,
  compact,
  event,
  height,
  left,
  onCommitMove,
  onCommitResize,
  onPress,
  timeZone,
  top,
  width,
}: {
  color: string;
  /** Seven columns on a phone: smaller type, no time line. */
  compact: boolean;
  event: EventRecord;
  height: number;
  left: DimensionValue;
  onCommitMove: (deltaMinutes: number) => void;
  onCommitResize: (deltaMinutes: number) => void;
  onPress: () => void;
  timeZone: string;
  top: number;
  width: DimensionValue;
}) {
  const translateY = useSharedValue(0);
  const extraHeight = useSharedValue(0);
  const lifted = useSharedValue(0);
  // Recurring instances drag too — the commit becomes a single-instance override.
  const draggable = !event.recurrence;

  const commitMove = (translationPx: number) => {
    translateY.value = 0;
    lifted.value = 0;
    const deltaMinutes = pxToMinutes(translationPx);
    if (Math.round(deltaMinutes / 15) !== 0) {
      onCommitMove(deltaMinutes);
    }
  };
  const commitResize = (translationPx: number) => {
    extraHeight.value = 0;
    const deltaMinutes = pxToMinutes(translationPx);
    if (Math.round(deltaMinutes / 15) !== 0) {
      onCommitResize(deltaMinutes);
    }
  };

  const movePan = Gesture.Pan()
    .enabled(draggable)
    .activateAfterLongPress(250)
    .onStart(() => {
      lifted.value = withTiming(1, { duration: 120 });
    })
    .onUpdate((update) => {
      translateY.value = Math.round(update.translationY / SNAP_PX) * SNAP_PX;
    })
    .onEnd((end) => {
      runOnJS(commitMove)(end.translationY);
    })
    .onFinalize(() => {
      lifted.value = withTiming(0, { duration: 120 });
    });

  const resizePan = Gesture.Pan()
    .enabled(draggable)
    .onUpdate((update) => {
      extraHeight.value = Math.round(update.translationY / SNAP_PX) * SNAP_PX;
    })
    .onEnd((end) => {
      runOnJS(commitResize)(end.translationY);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    height: Math.max(height - 2 + extraHeight.value, SNAP_PX),
    shadowOpacity: lifted.value * 0.3,
    transform: [{ translateY: translateY.value }, { scale: 1 + lifted.value * 0.02 }],
    zIndex: translateY.value !== 0 || lifted.value > 0 ? 10 : 0,
  }));

  return (
    <GestureDetector gesture={movePan}>
      <Animated.View
        style={[
          styles.eventBlock,
          { backgroundColor: color, left, top, width },
          styles.eventShadow,
          animatedStyle,
        ]}
      >
        <Pressable onPress={onPress} style={styles.eventPressable}>
          <Text
            numberOfLines={compact ? 2 : 1}
            style={[
              styles.eventTitle,
              compact && styles.eventTitleCompact,
              { color: chipTextColor(color) },
            ]}
          >
            {event.title}
          </Text>
          {!compact && height > 34 ? (
            <Text numberOfLines={1} style={[styles.eventTime, { color: chipTextColor(color) }]}>
              {formatClockTime(event.startUtc, timeZone)} –{' '}
              {formatClockTime(event.endUtc, timeZone)}
            </Text>
          ) : null}
        </Pressable>
        {draggable ? (
          <GestureDetector gesture={resizePan}>
            <View style={styles.resizeHandle} />
          </GestureDetector>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}

/** One day's timed events, sized against that day's own range. */
function DayColumn({
  colorOf,
  compact,
  date,
  events,
  isToday,
  nowMs,
  onCommit,
  onEventPress,
  timeZone,
  width,
}: {
  colorOf: (event: EventRecord) => string;
  compact: boolean;
  date: Temporal.PlainDate;
  /** Timed events touching this day. */
  events: ReadonlyArray<EventRecord>;
  isToday: boolean;
  nowMs: number;
  onCommit: (event: EventRecord, changes: { endUtc?: number; startUtc?: number }) => void;
  onEventPress: (event: EventRecord) => void;
  timeZone: string;
  width: number;
}) {
  const range = dayRange(date, timeZone);
  const boxes = layoutDayColumn(
    events.map((event) => ({
      endUtc: event.endUtc,
      id: `${event.calendarId}:${event.id}`,
      startUtc: event.startUtc,
    })),
    range.startUtc,
    range.endUtc,
  );
  const byId = new Map(events.map((event) => [`${event.calendarId}:${event.id}`, event]));
  const nowFraction = (nowMs - range.startUtc) / (range.endUtc - range.startUtc);

  return (
    <View style={[styles.dayColumn, compact && styles.dayColumnCompact, { width }]}>
      {boxes.map((box) => {
        const event = byId.get(box.id)!;
        return (
          <DraggableEventBlock
            color={colorOf(event)}
            compact={compact}
            event={event}
            height={Math.max(box.height * 24 * HOUR_HEIGHT, 22)}
            key={box.id}
            left={`${box.left * 100}%` as DimensionValue}
            onCommitMove={(deltaMinutes) => onCommit(event, moveEventTimes(event, deltaMinutes))}
            onCommitResize={(deltaMinutes) => onCommit(event, resizeEventEnd(event, deltaMinutes))}
            onPress={() => onEventPress(event)}
            timeZone={timeZone}
            top={box.top * 24 * HOUR_HEIGHT}
            width={`${box.width * 100}%` as DimensionValue}
          />
        );
      })}

      {isToday && nowFraction >= 0 && nowFraction <= 1 ? (
        <View style={[styles.nowLine, { top: nowFraction * 24 * HOUR_HEIGHT }]}>
          <View style={styles.nowDot} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * One day's all-day chips (due tasks first, then events), one chip per
 * row. Past `maxChips` the column shows the first rows and a "+N more"
 * chip that expands the lane.
 */
function AllDayColumn({
  colorOf,
  compact,
  events,
  listColorOf,
  maxChips,
  onEventPress,
  onShowMore,
  onTaskPress,
  onToggleTask,
  tasks,
  width,
}: {
  colorOf: (event: EventRecord) => string;
  compact: boolean;
  /** All-day events on this day. */
  events: ReadonlyArray<EventRecord>;
  listColorOf: (task: TaskRecord) => string | undefined;
  maxChips: number;
  onEventPress: (event: EventRecord) => void;
  onShowMore: () => void;
  onTaskPress: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  /** Tasks due on this day. */
  tasks: ReadonlyArray<TaskRecord>;
  width: number;
}) {
  const total = tasks.length + events.length;
  // A column that fits shows everything; one that overflows gives its
  // last row to the "+N more" chip.
  const limit = total > maxChips ? maxChips - 1 : total;
  const visibleTasks = tasks.slice(0, limit);
  const visibleEvents = events.slice(0, Math.max(limit - visibleTasks.length, 0));
  const hidden = total - visibleTasks.length - visibleEvents.length;
  return (
    <View style={[styles.allDayColumn, { width }]}>
      {visibleTasks.map((task) => {
        const done = task.status === 'completed';
        const listColor = listColorOf(task);
        return (
          <View
            key={`task:${task.listId}:${task.id}`}
            style={[
              styles.allDayChip,
              styles.taskChip,
              // Reminders lists have colors; a left accent tells them apart
              // from Google tasks without recoloring the whole chip.
              listColor ? { borderLeftColor: listColor, borderLeftWidth: 3 } : null,
              done && styles.taskChipDone,
            ]}
            testID={`task-chip-${task.id}`}
          >
            {/* Side-by-side Pressables — no nested-press arbitration. The
                labels double as stable e2e handles: a created task's id
                swaps from local- to the server id as soon as its op
                pushes, so id-based selectors go stale mid-flow — the
                title does not. */}
            <Pressable
              accessibilityLabel={`Toggle ${task.title}`}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => onToggleTask(task)}
              testID={`task-chip-toggle-${task.id}`}
            >
              <Text style={styles.taskCheckbox}>{done ? '☑' : '☐'}</Text>
            </Pressable>
            <Pressable
              hitSlop={4}
              onPress={() => onTaskPress(task)}
              style={styles.taskBody}
              testID={`task-chip-body-${task.id}`}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.allDayText,
                  compact && styles.allDayTextCompact,
                  styles.taskText,
                  done && styles.taskTextDone,
                ]}
              >
                {taskChipLabel(task)}
              </Text>
            </Pressable>
          </View>
        );
      })}
      {visibleEvents.map((event) => {
        const color = colorOf(event);
        // A Pressable like the task chip body: an all-day event opens
        // its editor on the phone the way it does on desktop.
        return (
          <Pressable
            accessibilityLabel={event.title}
            accessibilityRole="button"
            hitSlop={4}
            key={`${event.calendarId}:${event.id}`}
            onPress={() => onEventPress(event)}
            style={[styles.allDayChip, { backgroundColor: color }]}
            testID="all-day-event-chip"
          >
            <Text
              numberOfLines={1}
              style={[
                styles.allDayText,
                compact && styles.allDayTextCompact,
                { color: chipTextColor(color) },
              ]}
            >
              {event.title}
            </Text>
          </Pressable>
        );
      })}
      {hidden > 0 ? (
        <Pressable
          accessibilityLabel={`${String(hidden)} more all-day items, show all`}
          accessibilityRole="button"
          hitSlop={4}
          onPress={onShowMore}
          style={[styles.allDayChip, styles.moreChip]}
          testID="all-day-more"
        >
          <Text numberOfLines={1} style={[styles.allDayText, styles.moreText]}>
            +{hidden} more
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The timed grid for one day or one week: `days` are the visible columns,
 * `buffer` neighbours on each side stay drawn so a swipe reveals content.
 * A swipe pages by the visible width (one day or one week).
 */
export function DayTimeline({
  buffer,
  colorOf,
  days,
  events,
  listColorOf,
  onEventPress,
  onNavigate,
  onTaskPress,
  onToggleTask,
  tasks,
  timeZone,
}: {
  buffer: number;
  colorOf: (event: EventRecord) => string;
  days: ReadonlyArray<Temporal.PlainDate>;
  events: ReadonlyArray<EventRecord>;
  listColorOf: (task: TaskRecord) => string | undefined;
  onEventPress: (event: EventRecord) => void;
  /** Swipe committed a page change: +1 forward, -1 back. */
  onNavigate: (direction: 1 | -1) => void;
  onTaskPress: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const nowMs = useNow();
  const { updateEvent, updateRecurring } = useGuardedMutations();
  const [pageWidth, setPageWidth] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const panX = useSharedValue(0);
  const compact = days.length > 1;
  const columnWidth = pageWidth / days.length;
  const today = Temporal.Now.plainDateISO(timeZone);

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
  const tasksByDay = useMemo(() => {
    const map = new Map<string, Array<TaskRecord>>();
    for (const task of tasks) {
      if (task.dueDate) {
        const bucket = map.get(task.dueDate) ?? [];
        bucket.push(task);
        map.set(task.dueDate, bucket);
      }
    }
    return map;
  }, [tasks]);

  // The lane sizes itself to the busiest drawn day (neighbours included)
  // so a swipe never shifts the grid; only a committed page change can.
  const rowsNeeded = Math.max(
    0,
    ...strip.map((day) => {
      const iso = day.toString();
      return (
        (tasksByDay.get(iso)?.length ?? 0) +
        (byDay.get(iso) ?? []).filter((event) => event.isAllDay).length
      );
    }),
  );
  const capped = !expanded && rowsNeeded > MAX_ALL_DAY_ROWS;
  const laneHeight = Math.max(capped ? MAX_ALL_DAY_ROWS : rowsNeeded, 1) * ALL_DAY_ROW_HEIGHT + 4;
  const maxChips = capped ? MAX_ALL_DAY_ROWS : Number.POSITIVE_INFINITY;

  useEffect(() => {
    scrollRef.current?.scrollTo({ animated: false, y: 7.5 * HOUR_HEIGHT });
  }, []);

  // Re-centre once the new page has rendered — resetting in the same tick as
  // the state update would briefly show the wrong day. Also clears a stray
  // offset when the days change from outside (Today, chevrons, week strip).
  const firstIso = days[0]!.toString();
  useLayoutEffect(() => {
    setShared(panX, 0);
  }, [firstIso, panX]);

  const swipe = Gesture.Pan()
    // Only clearly horizontal movement pans; vertical stays with the ScrollView,
    // and event blocks win the arena via their long-press activation.
    .activeOffsetX([-15, 15])
    .failOffsetY([-12, 12])
    .onUpdate((update) => {
      // One page per gesture, like Apple's calendar.
      setShared(panX, Math.max(-pageWidth, Math.min(pageWidth, update.translationX)));
    })
    .onEnd((end) => {
      if (pageWidth === 0) {
        setShared(panX, withTiming(0, { duration: 160 }));
        return;
      }
      const direction = swipeSnapDecision(end.translationX, end.velocityX, pageWidth);
      if (direction !== 0) {
        setShared(
          panX,
          withTiming(-direction * pageWidth, { duration: 180 }, (finished) => {
            if (finished) {
              runOnJS(onNavigate)(direction);
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
    <View style={styles.container} testID="day-timeline">
      <View style={[styles.allDayLane, { height: laneHeight }]}>
        <View style={styles.gutterSpacer}>
          {expanded && rowsNeeded > MAX_ALL_DAY_ROWS ? (
            <Pressable
              accessibilityLabel="Collapse the all-day lane"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setExpanded(false)}
            >
              <Text style={[styles.gutterLabel, styles.gutterAction]}>less</Text>
            </Pressable>
          ) : (
            <Text style={styles.gutterLabel}>all-day</Text>
          )}
        </View>
        <View style={styles.stripViewport}>
          <Animated.View style={[styles.strip, stripStyle]}>
            {strip.map((day) => {
              const iso = day.toString();
              return (
                <AllDayColumn
                  colorOf={colorOf}
                  compact={compact}
                  events={(byDay.get(iso) ?? []).filter((event) => event.isAllDay)}
                  key={iso}
                  listColorOf={listColorOf}
                  maxChips={maxChips}
                  onEventPress={onEventPress}
                  onShowMore={() => setExpanded(true)}
                  onTaskPress={onTaskPress}
                  onToggleTask={onToggleTask}
                  tasks={tasksByDay.get(iso) ?? []}
                  width={columnWidth}
                />
              );
            })}
          </Animated.View>
        </View>
      </View>

      <GestureDetector gesture={swipe}>
        <ScrollView ref={scrollRef} style={styles.scroll}>
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
                {strip.map((day) => {
                  const iso = day.toString();
                  return (
                    <DayColumn
                      colorOf={colorOf}
                      compact={compact}
                      date={day}
                      events={(byDay.get(iso) ?? []).filter((event) => !event.isAllDay)}
                      isToday={Temporal.PlainDate.compare(day, today) === 0}
                      key={iso}
                      nowMs={nowMs}
                      onCommit={commitChange}
                      onEventPress={onEventPress}
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
    </View>
  );
}
const styles = StyleSheet.create({
  allDayChip: {
    borderRadius: 5,
    height: ALL_DAY_ROW_HEIGHT - 4,
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  allDayColumn: {
    gap: 4,
    paddingHorizontal: 2,
    paddingVertical: 2,
  },
  allDayLane: {
    borderBottomColor: palette.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
  },
  allDayText: {
    fontSize: 13,
    fontWeight: '500',
  },
  allDayTextCompact: {
    fontSize: 11,
  },
  container: {
    flex: 1,
  },
  dayColumn: {
    height: 24 * HOUR_HEIGHT,
  },
  dayColumnCompact: {
    borderLeftColor: palette.gridLine,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  eventBlock: {
    borderRadius: 6,
    position: 'absolute',
  },
  eventPressable: {
    flex: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  eventsArea: {
    bottom: 0,
    left: GUTTER_WIDTH,
    overflow: 'hidden',
    position: 'absolute',
    right: EDGE_INSET,
    top: 0,
  },
  eventShadow: {
    shadowColor: '#000000',
    shadowOffset: { height: 4, width: 0 },
    shadowRadius: 8,
  },
  eventTime: {
    fontSize: 11,
    opacity: 0.85,
  },
  eventTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  eventTitleCompact: {
    fontSize: 11,
    lineHeight: 13,
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
  moreChip: {
    backgroundColor: '#f5f5f5',
  },
  moreText: {
    color: palette.textMuted,
    fontSize: 11,
  },
  nowDot: {
    backgroundColor: palette.today,
    borderRadius: 4,
    height: 8,
    left: -4,
    position: 'absolute',
    top: -3,
    width: 8,
  },
  nowLine: {
    backgroundColor: palette.today,
    height: 2,
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 10,
  },
  resizeHandle: {
    bottom: 0,
    height: 16,
    left: 0,
    position: 'absolute',
    right: 0,
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
  taskBody: {
    flexShrink: 1,
  },
  taskCheckbox: {
    color: '#525252',
    fontSize: 12,
  },
  taskChip: {
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    borderColor: '#d4d4d4',
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 3,
  },
  taskChipDone: {
    opacity: 0.5,
  },
  taskText: {
    color: '#404040',
  },
  taskTextDone: {
    textDecorationLine: 'line-through',
  },
});
