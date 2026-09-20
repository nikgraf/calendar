/* eslint-disable react/immutability -- Reanimated shared values are mutable
   refs by design (`.value =` is the API); the React Compiler lint cannot tell
   them from hook state. */
import { commitTaskDrop, useGuardedMutations } from '@calendar/app-state';
import {
  calendarTaskKey,
  type DropTarget,
  dropTargetAt,
  type TaskRecord,
  type Temporal,
} from '@calendar/core';
import { useState } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { GUTTER_WIDTH, HOUR_HEIGHT } from './timelineLayout.ts';

/** Where a task drag started: its chip in the all-day lane, or its block in the grid. */
export type TaskDragFrom = 'grid' | 'lane';

export interface TaskDragging {
  readonly from: TaskDragFrom;
  readonly key: string;
  readonly task: TaskRecord;
}

/** The timeline geometry a drop is judged against, in the timeline container's coordinates. */
export interface TaskDragLayout {
  readonly buffer: number;
  readonly columnWidth: number;
  /** The container's window origin and height (measured on layout). */
  readonly containerHeight: SharedValue<number>;
  readonly containerX: SharedValue<number>;
  readonly containerY: SharedValue<number>;
  readonly laneHeight: number;
  /** Where the lane starts: below the week header, or at the top in the day view. */
  readonly laneTop: SharedValue<number>;
  readonly panX: SharedValue<number>;
  readonly scrollY: SharedValue<number>;
  readonly strip: ReadonlyArray<Temporal.PlainDate>;
}

const GHOST_HEIGHT = 22;
const NO_TARGET = 0;
const ALL_DAY_TARGET = 1;
const TIMED_TARGET = 2;

/**
 * Long-press drag of task chips across the all-day lane and the grid. The
 * lane and the grid are different containers (the grid scrolls), so the
 * dragged visual is a ghost hosted at the timeline level that follows the
 * finger, while indicators in the lane and the grid show where a release
 * would land. The drop is judged on the UI thread from shared geometry
 * (`dropTargetAt`), and committed on the JS thread through the same rules
 * as desktop (`dropTaskChanges`).
 */
export const useTaskDrag = (layout: TaskDragLayout) => {
  const { updateTask } = useGuardedMutations();
  const [dragging, setDragging] = useState<TaskDragging | null>(null);
  const ghostX = useSharedValue(0);
  const ghostY = useSharedValue(0);
  const ghostOpacity = useSharedValue(0);
  const targetKind = useSharedValue(NO_TARGET);
  const targetDay = useSharedValue(0);
  const targetMinute = useSharedValue(0);
  const {
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
  } = layout;
  const dayCount = strip.length;

  const targetAt = (windowX: number, windowY: number): DropTarget | null => {
    'worklet';
    const laneBottom = laneTop.value + laneHeight;
    return dropTargetAt(windowX - containerX.value, windowY - containerY.value, {
      columnWidth,
      dayCount,
      grid: { bottom: containerHeight.value, top: laneBottom },
      gridContentTop: laneBottom - scrollY.value,
      hourHeight: HOUR_HEIGHT,
      lane: { bottom: laneBottom, top: laneTop.value },
      stripLeft: GUTTER_WIDTH - buffer * columnWidth + panX.value,
    });
  };

  const place = (windowX: number, windowY: number) => {
    'worklet';
    ghostX.value = windowX - containerX.value;
    ghostY.value = windowY - containerY.value;
    const target = targetAt(windowX, windowY);
    if (target === null) {
      targetKind.value = NO_TARGET;
      return;
    }
    targetKind.value = target.kind === 'allDay' ? ALL_DAY_TARGET : TIMED_TARGET;
    targetDay.value = target.dayIndex;
    targetMinute.value = target.kind === 'timed' ? target.minute : 0;
  };

  const begin = (next: TaskDragging) => setDragging(next);
  const clear = () => setDragging(null);
  const finish = (task: TaskRecord, target: DropTarget | null) => {
    const day = target === null ? undefined : strip[target.dayIndex];
    if (target !== null && day !== undefined) {
      commitTaskDrop(task, day.toString(), target, updateTask);
    }
  };

  /**
   * The long-press pan for one chip or block. Created per render, like the
   * event blocks' own. The record stays on the JS side: the worklets call
   * back into closures bound here rather than capturing a class instance.
   */
  const gestureFor = (task: TaskRecord, from: TaskDragFrom, readOnly: boolean) => {
    const beginThis = () => begin({ from, key: calendarTaskKey(task), task });
    const finishThis = (target: DropTarget | null) => finish(task, target);
    return Gesture.Pan()
      .enabled(!readOnly)
      .activateAfterLongPress(250)
      .onStart((start) => {
        ghostOpacity.value = withTiming(1, { duration: 120 });
        place(start.absoluteX, start.absoluteY);
        runOnJS(beginThis)();
      })
      .onUpdate((update) => {
        place(update.absoluteX, update.absoluteY);
      })
      .onEnd((end, success) => {
        runOnJS(finishThis)(success ? targetAt(end.absoluteX, end.absoluteY) : null);
      })
      .onFinalize(() => {
        targetKind.value = NO_TARGET;
        ghostOpacity.value = withTiming(0, { duration: 120 });
        runOnJS(clear)();
      });
  };

  // The ghost sits under the finger, a little above it so the thumb does
  // not cover it; its width is one column, like the chip it stands for.
  const ghostStyle = useAnimatedStyle(() => ({
    opacity: ghostOpacity.value,
    transform: [
      { translateX: ghostX.value - columnWidth / 2 },
      { translateY: ghostY.value - GHOST_HEIGHT - 12 },
    ],
    width: columnWidth,
  }));
  const laneIndicatorStyle = useAnimatedStyle(() => ({
    opacity: targetKind.value === ALL_DAY_TARGET ? 1 : 0,
    transform: [{ translateX: targetDay.value * columnWidth }],
  }));
  const gridIndicatorStyle = useAnimatedStyle(() => ({
    opacity: targetKind.value === TIMED_TARGET ? 1 : 0,
    transform: [
      { translateX: targetDay.value * columnWidth },
      { translateY: (targetMinute.value / 60) * HOUR_HEIGHT },
    ],
  }));

  return { dragging, gestureFor, ghostStyle, gridIndicatorStyle, laneIndicatorStyle };
};

export type TaskDrag = ReturnType<typeof useTaskDrag>;
