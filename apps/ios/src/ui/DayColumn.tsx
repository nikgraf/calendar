import {
  calendarTaskKey,
  type EventRecord,
  formatPlainTime,
  layoutDayColumn,
  minuteOfDay,
  moveEventTimes,
  resizeEventEnd,
  slotFromHold,
  type SlotRange,
  slotTimes,
  type TaskRecord,
  Temporal,
  timedEventBox,
  timedTaskSlot,
} from '@calendar/core';
import { useState } from 'react';
import { StyleSheet, Text, View, type DimensionValue } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { DraggableEventBlock } from './DraggableEventBlock.tsx';
import { NowIndicator } from './NowIndicator.tsx';
import { TimedTaskBlock } from './TimedTaskBlock.tsx';
import { palette } from './theme.ts';
import { HOUR_HEIGHT } from './timelineLayout.ts';

/** Hold this long on empty space before a drag draws a slot instead of scrolling. */
const HOLD_TO_CREATE_MS = 300;

/**
 * Writes a shared value from a gesture callback; a helper keeps the write
 * off a hook-owned local, which the React Compiler treats as immutable.
 */
const setShared = (shared: SharedValue<number>, value: number) => {
  'worklet';
  shared.value = value;
};

/** One day's timed events, sized against that day's own range. */
export function DayColumn({
  colorOf,
  compact,
  date,
  events,
  isTaskReadOnly,
  isToday,
  listColorOf,
  onCommit,
  onCommitTask,
  onCreateSlot,
  onEventPress,
  onTaskPress,
  onToggleTask,
  timedTasks,
  timeZone,
  width,
}: {
  colorOf: (event: EventRecord) => string;
  compact: boolean;
  date: Temporal.PlainDate;
  /** Timed events touching this day. */
  events: ReadonlyArray<EventRecord>;
  isTaskReadOnly: (task: TaskRecord) => boolean;
  isToday: boolean;
  listColorOf: (task: TaskRecord) => string | undefined;
  onCommit: (event: EventRecord, changes: { endUtc?: number; startUtc?: number }) => void;
  onCommitTask: (task: TaskRecord, deltaMinutes: number) => void;
  /** A slot drawn by holding on empty space (and dragging to stretch it). */
  onCreateSlot: (
    date: Temporal.PlainDate,
    times: { readonly endTime: string; readonly startTime: string },
  ) => void;
  onEventPress: (event: EventRecord) => void;
  onTaskPress: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  timedTasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  width: number;
}) {
  const boxes = layoutDayColumn(
    events
      .map((event) => timedEventBox(event, `${event.calendarId}:${event.id}`, date, timeZone))
      .concat(
        timedTasks.flatMap((task) => {
          const slot = timedTaskSlot(task);
          return slot === undefined ? [] : [{ ...slot, id: calendarTaskKey(task) }];
        }),
      ),
  );
  const byId = new Map(events.map((event) => [`${event.calendarId}:${event.id}`, event]));
  const tasksById = new Map(timedTasks.map((task) => [calendarTaskKey(task), task]));

  // The slot being drawn. React state only changes when the snapped slot
  // does, so a stretch re-renders this column at most once per quarter hour.
  const [selection, setSelection] = useState<SlotRange | null>(null);
  const anchor = useSharedValue(0);
  const shownStart = useSharedValue(-1);
  const shownEnd = useSharedValue(-1);

  const clearSelection = () => setSelection(null);
  const createSlot = (startMinute: number, endMinute: number) => {
    setSelection(null);
    onCreateSlot(date, slotTimes({ endMinute, startMinute }));
  };

  // Hold on empty space, then drag to stretch. A finger that moves before
  // the hold completes fails this gesture, so the timeline scrolls and the
  // day swipe pages exactly as before — the arrangement the event blocks'
  // own long-press drag relies on. Blocks are drawn above this layer, so a
  // touch on an event never reaches it.
  const createPan = Gesture.Pan()
    .activateAfterLongPress(HOLD_TO_CREATE_MS)
    // The anchor is where the finger touched down, not where it rests once
    // the hold completes: the recognizer tolerates a few points of drift
    // during the hold, which is a couple of minutes on this grid.
    .onBegin((begin) => {
      setShared(anchor, minuteOfDay(begin.y, HOUR_HEIGHT));
    })
    .onStart((start) => {
      const slot = slotFromHold(anchor.value, minuteOfDay(start.y, HOUR_HEIGHT));
      setShared(shownStart, slot.startMinute);
      setShared(shownEnd, slot.endMinute);
      runOnJS(setSelection)(slot);
    })
    .onUpdate((update) => {
      const slot = slotFromHold(anchor.value, minuteOfDay(update.y, HOUR_HEIGHT));
      if (slot.startMinute !== shownStart.value || slot.endMinute !== shownEnd.value) {
        setShared(shownStart, slot.startMinute);
        setShared(shownEnd, slot.endMinute);
        runOnJS(setSelection)(slot);
      }
    })
    // Create exactly the slot on screen, not one recomputed from where the
    // finger lifts: lifting drifts too.
    .onEnd((_end, success) => {
      if (success && shownStart.value >= 0) {
        runOnJS(createSlot)(shownStart.value, shownEnd.value);
      }
    })
    .onFinalize(() => {
      setShared(shownStart, -1);
      setShared(shownEnd, -1);
      runOnJS(clearSelection)();
    });

  return (
    <View style={[styles.dayColumn, compact && styles.dayColumnCompact, { width }]}>
      <GestureDetector gesture={createPan}>
        <View style={StyleSheet.absoluteFill} />
      </GestureDetector>

      {boxes.map((box) => {
        const task = tasksById.get(box.id);
        if (task) {
          return (
            <TimedTaskBlock
              compact={compact}
              key={box.id}
              left={`${box.left * 100}%` as DimensionValue}
              listColor={listColorOf(task)}
              onCommitMove={(deltaMinutes) => onCommitTask(task, deltaMinutes)}
              onPress={() => onTaskPress(task)}
              onToggle={() => onToggleTask(task)}
              readOnly={isTaskReadOnly(task)}
              task={task}
              top={box.top * 24 * HOUR_HEIGHT}
              width={`${box.width * 100}%` as DimensionValue}
            />
          );
        }
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

      {isToday ? <NowIndicator date={date} timeZone={timeZone} /> : null}

      {selection ? (
        <View
          pointerEvents="none"
          style={[
            styles.slot,
            {
              height: ((selection.endMinute - selection.startMinute) / 60) * HOUR_HEIGHT,
              top: (selection.startMinute / 60) * HOUR_HEIGHT,
            },
          ]}
          testID="slot-selection"
        >
          {compact ? null : (
            <Text numberOfLines={1} style={styles.slotLabel}>
              {formatPlainTime(slotTimes(selection).startTime)} –{' '}
              {formatPlainTime(slotTimes(selection).endTime)}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dayColumn: {
    height: 24 * HOUR_HEIGHT,
  },
  dayColumnCompact: {
    borderLeftColor: palette.gridLine,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  slot: {
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    borderColor: '#3b82f6',
    borderRadius: 6,
    borderWidth: 1,
    left: 2,
    paddingHorizontal: 4,
    position: 'absolute',
    right: 2,
    zIndex: 20,
  },
  slotLabel: {
    color: '#1d4ed8',
    fontSize: 11,
    fontWeight: '600',
  },
});
