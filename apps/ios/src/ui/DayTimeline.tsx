import { useBackendMutations, useNow } from '@calendar/app-state';
import {
  dayRange,
  layoutDayColumn,
  moveEventTimes,
  resizeEventEnd,
  Temporal,
  type EventRecord,
} from '@calendar/core';
import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type DimensionValue } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { chipTextColor, palette } from './theme.ts';

const HOUR_HEIGHT = 56;
const SNAP_PX = HOUR_HEIGHT / 4; // 15 minutes
const pxToMinutes = (px: number) => (px / HOUR_HEIGHT) * 60;

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

export function DayTimeline({
  colorOf,
  date,
  events,
  onEventPress,
  timeZone,
}: {
  colorOf: (event: EventRecord) => string;
  date: Temporal.PlainDate;
  events: ReadonlyArray<EventRecord>;
  onEventPress: (event: EventRecord) => void;
  timeZone: string;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const nowMs = useNow();
  const { updateEvent, updateRecurring } = useBackendMutations();

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
  const range = dayRange(date, timeZone);
  const isToday = Temporal.PlainDate.compare(date, Temporal.Now.plainDateISO(timeZone)) === 0;

  useEffect(() => {
    scrollRef.current?.scrollTo({ animated: false, y: 7.5 * HOUR_HEIGHT });
  }, []);

  const allDay = events.filter(
    (event) => event.isAllDay && event.startUtc < range.endUtc && event.endUtc > range.startUtc,
  );
  const timed = events.filter(
    (event) => !event.isAllDay && event.startUtc < range.endUtc && event.endUtc > range.startUtc,
  );
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
    <View style={styles.container}>
      {allDay.length > 0 ? (
        <View style={styles.allDayLane}>
          {allDay.map((event) => {
            const color = colorOf(event);
            return (
              <View
                key={`${event.calendarId}:${event.id}`}
                style={[styles.allDayChip, { backgroundColor: color }]}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.allDayText, { color: chipTextColor(color) }]}
                >
                  {event.title}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

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

          <View style={styles.eventsArea}>
            {boxes.map((box) => {
              const event = byId.get(box.id)!;
              return (
                <DraggableEventBlock
                  color={colorOf(event)}
                  event={event}
                  height={Math.max(box.height * 24 * HOUR_HEIGHT, 22)}
                  key={box.id}
                  left={`${box.left * 100}%` as DimensionValue}
                  onCommitMove={(deltaMinutes) =>
                    commitChange(event, moveEventTimes(event, deltaMinutes))
                  }
                  onCommitResize={(deltaMinutes) =>
                    commitChange(event, resizeEventEnd(event, deltaMinutes))
                  }
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
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  allDayChip: {
    borderRadius: 6,
    marginBottom: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  allDayLane: {
    borderBottomColor: palette.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  allDayText: {
    fontSize: 13,
    fontWeight: '500',
  },
  container: {
    flex: 1,
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
    left: 56,
    position: 'absolute',
    right: 8,
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
});
