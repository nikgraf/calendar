import { useGuardedMutations } from '@calendar/app-state';
import {
  bufferedDays,
  type EventRecord,
  groupEventsByDay,
  swipeSnapDecision,
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
import {
  ALL_DAY_ROW_HEIGHT,
  EDGE_INSET,
  GUTTER_WIDTH,
  HOUR_HEIGHT,
  MAX_ALL_DAY_ROWS,
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
});
