import { useGuardedMutations, useNow } from '@calendar/app-state';
import {
  bufferedDays,
  DAY_SWIPE_BUFFER,
  dayRange,
  type EventRecord,
  eventsOnDay,
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

const HOUR_HEIGHT = 56;
const SNAP_PX = HOUR_HEIGHT / 4; // 15 minutes
const GUTTER_WIDTH = 56;
const EDGE_INSET = 8;
/** Lane is always rendered at this height so swiping never shifts the grid. */
const ALL_DAY_HEIGHT = 34;
const pxToMinutes = (px: number) => (px / HOUR_HEIGHT) * 60;

/**
 * Writes a shared value from a worklet or callback. Going through a helper
 * keeps the write off a hook-owned local, which the React Compiler treats as
 * immutable.
 */
const setShared = (shared: SharedValue<number>, value: number) => {
  'worklet';
  shared.value = value;
};

const formatTime = (epochMs: number, timeZone: string): string =>
  Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timeZone)
    .toPlainTime()
    .toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });
function DraggableEventBlock({
  color,
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
          <Text numberOfLines={1} style={[styles.eventTitle, { color: chipTextColor(color) }]}>
            {event.title}
          </Text>
          {height > 34 ? (
            <Text numberOfLines={1} style={[styles.eventTime, { color: chipTextColor(color) }]}>
              {formatTime(event.startUtc, timeZone)} – {formatTime(event.endUtc, timeZone)}
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
  date,
  events,
  nowMs,
  onCommit,
  onEventPress,
  timeZone,
  width,
}: {
  colorOf: (event: EventRecord) => string;
  date: Temporal.PlainDate;
  events: ReadonlyArray<EventRecord>;
  nowMs: number;
  onCommit: (event: EventRecord, changes: { endUtc?: number; startUtc?: number }) => void;
  onEventPress: (event: EventRecord) => void;
  timeZone: string;
  width: number;
}) {
  const range = dayRange(date, timeZone);
  const isToday = Temporal.PlainDate.compare(date, Temporal.Now.plainDateISO(timeZone)) === 0;
  const timed = eventsOnDay(events, date, timeZone).filter((event) => !event.isAllDay);
  const boxes = layoutDayColumn(
    timed.map((event) => ({
      endUtc: event.endUtc,
      id: `${event.calendarId}:${event.id}`,
      startUtc: event.startUtc,
    })),
    range.startUtc,
    range.endUtc,
  );
  const byId = new Map(timed.map((event) => [`${event.calendarId}:${event.id}`, event]));
  const nowFraction = (nowMs - range.startUtc) / (range.endUtc - range.startUtc);

  return (
    <View style={[styles.dayColumn, { width }]}>
      {boxes.map((box) => {
        const event = byId.get(box.id)!;
        return (
          <DraggableEventBlock
            color={colorOf(event)}
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

/** One day's all-day chips (events + due tasks), one fixed-height row. */
function AllDayColumn({
  colorOf,
  date,
  events,
  listColorOf,
  onTaskPress,
  onToggleTask,
  tasks,
  timeZone,
  width,
}: {
  colorOf: (event: EventRecord) => string;
  date: Temporal.PlainDate;
  events: ReadonlyArray<EventRecord>;
  listColorOf: (task: TaskRecord) => string | undefined;
  onTaskPress: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  width: number;
}) {
  const allDay = eventsOnDay(events, date, timeZone).filter((event) => event.isAllDay);
  const isoDay = date.toString();
  const due = tasks.filter((task) => task.dueDate === isoDay);
  return (
    <View style={[styles.allDayColumn, { width }]}>
      {due.map((task) => {
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
                style={[styles.allDayText, styles.taskText, done && styles.taskTextDone]}
              >
                {taskChipLabel(task)}
              </Text>
            </Pressable>
          </View>
        );
      })}
      {allDay.map((event) => {
        const color = colorOf(event);
        return (
          <View
            key={`${event.calendarId}:${event.id}`}
            style={[styles.allDayChip, { backgroundColor: color }]}
          >
            <Text numberOfLines={1} style={[styles.allDayText, { color: chipTextColor(color) }]}>
              {event.title}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function DayTimeline({
  colorOf,
  date,
  events,
  listColorOf,
  onEventPress,
  onNavigate,
  onTaskPress,
  onToggleTask,
  tasks,
  timeZone,
}: {
  colorOf: (event: EventRecord) => string;
  date: Temporal.PlainDate;
  events: ReadonlyArray<EventRecord>;
  listColorOf: (task: TaskRecord) => string | undefined;
  onEventPress: (event: EventRecord) => void;
  /** Swipe committed a day change: +1 forward, -1 back. */
  onNavigate: (direction: 1 | -1) => void;
  onTaskPress: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const nowMs = useNow();
  const { updateEvent, updateRecurring } = useGuardedMutations();
  const [columnWidth, setColumnWidth] = useState(0);
  const panX = useSharedValue(0);

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

  const days = useMemo(() => bufferedDays(date, 1, DAY_SWIPE_BUFFER), [date]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ animated: false, y: 7.5 * HOUR_HEIGHT });
  }, []);

  // Re-centre once the new day has rendered — resetting in the same tick as the
  // state update would briefly show the wrong day. Also clears a stray offset
  // when the date changes from outside (Today, chevrons, week strip).
  useLayoutEffect(() => {
    setShared(panX, 0);
  }, [date, panX]);

  const swipe = Gesture.Pan()
    // Only clearly horizontal movement pans; vertical stays with the ScrollView,
    // and event blocks win the arena via their long-press activation.
    .activeOffsetX([-15, 15])
    .failOffsetY([-12, 12])
    .onUpdate((update) => {
      // One day per gesture, like Apple's calendar.
      setShared(panX, Math.max(-columnWidth, Math.min(columnWidth, update.translationX)));
    })
    .onEnd((end) => {
      if (columnWidth === 0) {
        setShared(panX, withTiming(0, { duration: 160 }));
        return;
      }
      const direction = swipeSnapDecision(end.translationX, end.velocityX, columnWidth);
      if (direction !== 0) {
        setShared(
          panX,
          withTiming(-direction * columnWidth, { duration: 180 }, (finished) => {
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
    transform: [{ translateX: -columnWidth + panX.value }],
  }));

  return (
    <View style={styles.container} testID="day-timeline">
      <View style={styles.allDayLane}>
        <View style={styles.gutterSpacer} />
        <View style={styles.stripViewport}>
          <Animated.View style={[styles.strip, stripStyle]}>
            {days.map((day) => (
              <AllDayColumn
                colorOf={colorOf}
                date={day}
                events={events}
                key={day.toString()}
                listColorOf={listColorOf}
                onTaskPress={onTaskPress}
                onToggleTask={onToggleTask}
                tasks={tasks}
                timeZone={timeZone}
                width={columnWidth}
              />
            ))}
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
              onLayout={(layout) => setColumnWidth(layout.nativeEvent.layout.width)}
              style={styles.eventsArea}
            >
              <Animated.View style={[styles.strip, stripStyle]}>
                {days.map((day) => (
                  <DayColumn
                    colorOf={colorOf}
                    date={day}
                    events={events}
                    key={day.toString()}
                    nowMs={nowMs}
                    onCommit={commitChange}
                    onEventPress={onEventPress}
                    timeZone={timeZone}
                    width={columnWidth}
                  />
                ))}
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
    borderRadius: 6,
    flexShrink: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  allDayColumn: {
    flexDirection: 'row',
    gap: 4,
    paddingVertical: 4,
  },
  allDayLane: {
    borderBottomColor: palette.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    height: ALL_DAY_HEIGHT,
  },
  allDayText: {
    fontSize: 13,
    fontWeight: '500',
  },
  container: {
    flex: 1,
  },
  dayColumn: {
    height: 24 * HOUR_HEIGHT,
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
