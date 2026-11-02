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
import { usePanGesture } from 'react-native-gesture-handler';
import {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { HOUR_HEIGHT } from './timelineLayout.ts';
import type { EdgeScroll } from './useEdgeScroll.ts';

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
  /** Scrolls the grid while the finger is held near its top or bottom edge. */
  readonly edge: EdgeScroll;
  /** The hour gutter's width: where the strip's columns start. */
  readonly gutterWidth: number;
  readonly laneHeight: number;
  /** Where the lane starts: below the week header, or at the top in the day view. */
  readonly laneTop: SharedValue<number>;
  readonly scrollY: SharedValue<number>;
  readonly strip: ReadonlyArray<Temporal.PlainDate>;
  /** The strip's offset from its centred position (the swipe's pan). */
  readonly stripOffset: Readonly<SharedValue<number>>;
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
 * as desktop (`dropTaskChanges`). Held near the grid's top or bottom edge,
 * the drag scrolls the grid (`useEdgeScroll`) and re-judges its drop as the
 * grid moves under the finger.
 */
export const useTaskDrag = (layout: TaskDragLayout) => {
  // Not compiled: the edge scroll's reaction hands `place` to a hook, so the
  // compiler would key its memo on the geometry's `.value`s and read the
  // shared values during every render. Its worklets are rebuilt per render
  // anyway.
  'use no memo';
  const { updateTask } = useGuardedMutations();
  const [dragging, setDragging] = useState<TaskDragging | null>(null);
  const ghostX = useSharedValue(0);
  const ghostY = useSharedValue(0);
  const ghostOpacity = useSharedValue(0);
  const targetKind = useSharedValue(NO_TARGET);
  const targetDay = useSharedValue(0);
  const targetMinute = useSharedValue(0);
  // This drag is under way, and where its finger last was: the edge scroll
  // moves the grid under a finger that sends no updates.
  const active = useSharedValue(false);
  const lastX = useSharedValue(0);
  const lastY = useSharedValue(0);
  const {
    buffer,
    columnWidth,
    containerHeight,
    containerX,
    containerY,
    edge,
    gutterWidth,
    laneHeight,
    laneTop,
    scrollY,
    strip,
    stripOffset,
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
      stripLeft: gutterWidth - buffer * columnWidth + stripOffset.value,
    });
  };

  const place = (windowX: number, windowY: number) => {
    'worklet';
    lastX.value = windowX;
    lastY.value = windowY;
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

  // The UI-thread steps of every chip's and block's pan (`useTaskDragGesture`).
  const lift = (windowX: number, windowY: number) => {
    'worklet';
    active.value = true;
    ghostOpacity.value = withTiming(1, { duration: 120 });
    edge.begin();
    edge.follow(windowY);
    place(windowX, windowY);
  };
  const follow = (windowX: number, windowY: number) => {
    'worklet';
    edge.follow(windowY);
    place(windowX, windowY);
  };
  const settle = () => {
    'worklet';
    // A pan that never activated (a tap) leaves the edge scroll alone.
    if (active.value) {
      active.value = false;
      edge.end();
    }
    targetKind.value = NO_TARGET;
    ghostOpacity.value = withTiming(0, { duration: 120 });
  };

  // The grid scrolled under a still finger: the slot under it changed.
  useAnimatedReaction(
    () => edge.ticks.value,
    (tick, previous) => {
      if (active.value && previous !== null && tick !== previous) {
        place(lastX.value, lastY.value);
      }
    },
  );

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

  return {
    begin,
    clear,
    dragging,
    finish,
    follow,
    ghostStyle,
    gridIndicatorStyle,
    laneIndicatorStyle,
    lift,
    settle,
    targetAt,
  };
};

export type TaskDrag = ReturnType<typeof useTaskDrag>;

/**
 * The long-press pan for one chip or block, so each one's component calls
 * it. The record stays on the JS side: the worklets call back into
 * closures bound here rather than capturing a class instance.
 */
export const useTaskDragGesture = (
  drag: TaskDrag,
  task: TaskRecord,
  from: TaskDragFrom,
  readOnly: boolean,
) => {
  const { begin, clear, finish, follow, lift, settle, targetAt } = drag;
  const beginThis = () => begin({ from, key: calendarTaskKey(task), task });
  const finishThis = (target: DropTarget | null) => finish(task, target);
  return usePanGesture({
    activateAfterLongPress: 250,
    enabled: !readOnly,
    onActivate: (start) => {
      lift(start.absoluteX, start.absoluteY);
      scheduleOnRN(beginThis);
    },
    onDeactivate: (end) => {
      scheduleOnRN(finishThis, end.canceled ? null : targetAt(end.absoluteX, end.absoluteY));
    },
    onFinalize: () => {
      settle();
      scheduleOnRN(clear);
    },
    onUpdate: (update) => {
      follow(update.absoluteX, update.absoluteY);
    },
  });
};
