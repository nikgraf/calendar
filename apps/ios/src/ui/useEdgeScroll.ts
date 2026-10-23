/* eslint-disable react/immutability -- Reanimated shared values are mutable
   refs by design (`.value =` is the API); the React Compiler lint cannot tell
   them from hook state. */
import {
  EDGE_SCROLL_HOURS_PER_SECOND,
  EDGE_SCROLL_IDLE,
  type EdgeScrollState,
  edgeScrollStep,
} from '@calendar/core';
import type { ScrollView } from 'react-native';
import {
  type AnimatedRef,
  scrollTo,
  type SharedValue,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { HOUR_HEIGHT } from './timelineLayout.ts';

/** How deep the band along the grid's top and bottom edge is that scrolls a drag: an hour row, a fingertip with room. */
const EDGE_SCROLL_ZONE = HOUR_HEIGHT;
const EDGE_SCROLL_MAX_SPEED = EDGE_SCROLL_HOURS_PER_SECOND * HOUR_HEIGHT;
/** The longest frame the scroll moves by, so a dropped frame never jumps the grid. */
const EDGE_SCROLL_MAX_FRAME_MS = 50;

export interface EdgeScrollLayout {
  /** The timeline container's window origin and height (measured on layout). */
  readonly containerHeight: SharedValue<number>;
  readonly containerY: SharedValue<number>;
  /** The scrolled content's height: with the ScrollView's own, how far it scrolls. */
  readonly contentHeight: SharedValue<number>;
  readonly laneHeight: number;
  /** Where the lane starts in the container: the grid begins below it. */
  readonly laneTop: SharedValue<number>;
  readonly scrollRef: AnimatedRef<ScrollView>;
  /** The grid's scroll offset, kept on the UI thread. */
  readonly scrollY: SharedValue<number>;
  readonly viewportHeight: SharedValue<number>;
}

/**
 * Scrolls the timeline while a drag is held near the grid's top or bottom
 * edge (`edgeScrollStep`). A drag calls `begin`, `follow` with each finger
 * position and `end`, all on the UI thread; a frame loop scrolls, and bumps
 * `ticks` on each frame that moved the grid so the drag can re-judge itself
 * under a finger that has not moved (a still finger sends no pan updates).
 */
export const useEdgeScroll = (layout: EdgeScrollLayout) => {
  const {
    containerHeight,
    containerY,
    contentHeight,
    laneHeight,
    laneTop,
    scrollRef,
    scrollY,
    viewportHeight,
  } = layout;
  const active = useSharedValue(false);
  const state = useSharedValue<EdgeScrollState>(EDGE_SCROLL_IDLE);
  const velocity = useSharedValue(0);
  const ticks = useSharedValue(0);

  const frames = useFrameCallback((frame) => {
    if (!active.value || velocity.value === 0) {
      return;
    }
    const elapsed = Math.min(frame.timeSincePreviousFrame ?? 0, EDGE_SCROLL_MAX_FRAME_MS);
    // UIScrollView takes any offset it is given: clamp to the content.
    const max = Math.max(contentHeight.value - viewportHeight.value, 0);
    const next = Math.min(Math.max(scrollY.value + (velocity.value * elapsed) / 1000, 0), max);
    if (next === scrollY.value) {
      return;
    }
    scrollTo(scrollRef, 0, next, false);
    scrollY.value = next;
    ticks.value += 1;
  }, false);
  const loop = (on: boolean) => frames.setActive(on);

  const begin = () => {
    'worklet';
    active.value = true;
    state.value = EDGE_SCROLL_IDLE;
    velocity.value = 0;
    scheduleOnRN(loop, true);
  };
  /** The finger's window y: inside an edge's zone the loop scrolls, elsewhere it stands still. */
  const follow = (windowY: number) => {
    'worklet';
    if (!active.value) {
      return;
    }
    const step = edgeScrollStep(
      state.value,
      windowY,
      {
        bottom: containerY.value + containerHeight.value,
        top: containerY.value + laneTop.value + laneHeight,
      },
      EDGE_SCROLL_ZONE,
      EDGE_SCROLL_MAX_SPEED,
    );
    state.value = step.state;
    velocity.value = step.velocity;
  };
  // Stops at once on the UI thread: the drop is judged at this offset, and
  // a frame scrolled after it would move the grid under the dropped block.
  const end = () => {
    'worklet';
    active.value = false;
    velocity.value = 0;
    scheduleOnRN(loop, false);
  };

  return { begin, end, follow, scrollY, ticks };
};

export type EdgeScroll = ReturnType<typeof useEdgeScroll>;
