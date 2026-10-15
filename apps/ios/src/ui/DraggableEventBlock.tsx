/* eslint-disable react/immutability -- Reanimated shared values are mutable
   refs by design (`.value =` is the API); the React Compiler lint cannot tell
   them from hook state. */
import { type EventRecord, formatClockTime, formatZoneRange } from '@calendar/core';
import { useLayoutEffect } from 'react';
import { Pressable, StyleSheet, Text, type DimensionValue } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { BOX_FONT_SCALE, useEventTint } from './theme.ts';
import { pxToMinutes, SNAP_PX } from './timelineLayout.ts';
import type { EdgeScroll } from './useEdgeScroll.ts';

/**
 * How long a dropped block waits for its write to redraw it before it goes
 * back: a failed write (a toast says so) changes nothing.
 */
const DROP_SETTLE_MS = 1500;

/** What a drag does: a hold on the bottom edge resizes the block, anywhere else moves it. */
const MOVE = 1;
const RESIZE = 2;
/** How far up from the block's bottom a hold resizes it. */
const RESIZE_EDGE = 16;

const snapPx = (px: number): number => {
  'worklet';
  return Math.round(px / SNAP_PX) * SNAP_PX;
};

/**
 * A timed event in a timeline column: long-press-drag moves it (15-minute
 * snap), a long press on the bottom edge resizes it, a tap opens it. Held
 * near the grid's top or bottom edge, either drag scrolls the grid, and the
 * block moves by the finger's travel plus the scroll since the press.
 */
export function DraggableEventBlock({
  color,
  compact,
  edgeScroll,
  event,
  height,
  left,
  onCommitMove,
  onCommitResize,
  onPress,
  readOnly,
  secondaryZones,
  timeZone,
  top,
  width,
}: {
  color: string;
  /** Seven columns on a phone: smaller type, no time line. */
  compact: boolean;
  edgeScroll: EdgeScroll;
  event: EventRecord;
  height: number;
  left: DimensionValue;
  /** Resolves once the write is done (a failure has shown its toast). */
  onCommitMove: (deltaMinutes: number) => Promise<void>;
  onCommitResize: (deltaMinutes: number) => Promise<void>;
  onPress: () => void;
  /** In a calendar we cannot write: opens on tap, offers no move or resize. */
  readOnly: boolean;
  /** The non-primary zones; a tall block adds their start–end as a third line. */
  secondaryZones: ReadonlyArray<string>;
  timeZone: string;
  top: number;
  width: DimensionValue;
}) {
  const translateY = useSharedValue(0);
  const extraHeight = useSharedValue(0);
  const lifted = useSharedValue(0);
  // Bumped by every drag, so a drop's late fallback leaves a newer drag alone.
  const drags = useSharedValue(0);
  // 1 from a drop until the block is redrawn (or goes back): the block
  // shows a time its `event` does not have yet, so a drag then would start
  // from the wrong place and write a delta from the old time. It waits.
  const held = useSharedValue(0);
  // The drag under way, MOVE or RESIZE (0 for none, and while a hold waits
  // for `held`).
  const dragging = useSharedValue(0);
  // Whether the touch went down on the bottom edge: that picks the drag, as
  // a handle's hit test did, since a held finger may drift a few points
  // before the long press starts the pan.
  const onEdge = useSharedValue(false);
  // The grid's offset at the press, and the drag's last translation:
  // the block lives in the scrolled content, so a scroll under a still
  // finger moves it as far as the finger would.
  const startScroll = useSharedValue(0);
  const lastTranslation = useSharedValue(0);
  // Recurring instances drag too — the commit becomes a single-instance
  // override. Nothing in a calendar we cannot write moves.
  const draggable = !event.recurrence && !readOnly;

  // A drop stays where the finger left it until the block is drawn at its
  // new time: going back first and jumping forward when the write's
  // refetch lands read as a failed drop. New geometry lets go of it.
  useLayoutEffect(() => {
    translateY.value = 0;
    extraHeight.value = 0;
    held.value = 0;
  }, [top, height, translateY, extraHeight, held]);

  const goBack = (drag: number) => {
    'worklet';
    if (drags.value === drag) {
      held.value = 0;
      translateY.value = withTiming(0, { duration: 160 });
      extraHeight.value = withTiming(0, { duration: 160 });
    }
  };
  const begin = (kind: number, windowY: number) => {
    'worklet';
    if (held.value === 1 || dragging.value !== 0) {
      return;
    }
    dragging.value = kind;
    drags.value += 1;
    lifted.value = withTiming(1, { duration: 120 });
    startScroll.value = edgeScroll.scrollY.value;
    lastTranslation.value = 0;
    edgeScroll.begin();
    edgeScroll.follow(windowY);
  };
  const finish = () => {
    'worklet';
    if (dragging.value !== 0) {
      dragging.value = 0;
      lifted.value = withTiming(0, { duration: 120 });
      edgeScroll.end();
    }
  };
  /** How far the drag has moved the block: the finger's travel plus the scroll since the press. */
  const travel = (translationY: number): number => {
    'worklet';
    return translationY + edgeScroll.scrollY.value - startScroll.value;
  };
  /** Draws the drag at the finger's last translation. */
  const place = () => {
    'worklet';
    const shift = snapPx(travel(lastTranslation.value));
    if (dragging.value === MOVE) {
      translateY.value = shift;
    } else if (dragging.value === RESIZE) {
      extraHeight.value = shift;
    }
  };
  const update = (translationY: number, windowY: number) => {
    'worklet';
    if (dragging.value !== 0) {
      lastTranslation.value = translationY;
      edgeScroll.follow(windowY);
      place();
    }
  };
  // The edge scroll moved the grid under a still finger.
  useAnimatedReaction(
    () => edgeScroll.ticks.value,
    (tick, previous) => {
      if (previous !== null && tick !== previous) {
        place();
      }
    },
  );
  // The write resolves before its refetch redraws the block; a block still
  // displaced a moment later was not moved (the write failed or changed
  // nothing), so it goes back.
  const settle = (write: Promise<void>, drag: number) => {
    void write.then(() => {
      setTimeout(() => runOnUI(goBack)(drag), DROP_SETTLE_MS);
    });
  };

  const commitMove = (translationPx: number, drag: number) => {
    const deltaMinutes = pxToMinutes(translationPx);
    if (Math.round(deltaMinutes / 15) === 0) {
      runOnUI(goBack)(drag);
      return;
    }
    settle(onCommitMove(deltaMinutes), drag);
  };
  const commitResize = (translationPx: number, drag: number) => {
    const deltaMinutes = pxToMinutes(translationPx);
    if (Math.round(deltaMinutes / 15) === 0) {
      runOnUI(goBack)(drag);
      return;
    }
    settle(onCommitResize(deltaMinutes), drag);
  };

  // One pan for both drags, the touch-down picking which: a handle with
  // a pan of its own and the block's pan waiting on it both started, since
  // RNGH reports a long press active before UIKit lets a waiting pan begin,
  // and the waiting one, failed after it had started, never finalized —
  // the block stayed lifted and took no drag again. Held first, like a
  // move: a pan that took the bottom edge at once won the touch from the
  // ScrollView, and on a short block the edge is much of the block.
  const drawnHeight = Math.max(height - 2, SNAP_PX);
  const pan = Gesture.Pan()
    .enabled(draggable)
    .activateAfterLongPress(250)
    .onBegin((down) => {
      onEdge.value = down.y >= drawnHeight - RESIZE_EDGE;
    })
    .onStart((start) => {
      begin(onEdge.value ? RESIZE : MOVE, start.absoluteY);
    })
    .onUpdate((change) => {
      update(change.translationY, change.absoluteY);
    })
    .onEnd((end, success) => {
      if (dragging.value === 0) {
        return;
      }
      // A cancelled pan (the system took the touch) changes nothing.
      if (!success) {
        goBack(drags.value);
        return;
      }
      held.value = 1;
      if (dragging.value === MOVE) {
        runOnJS(commitMove)(travel(end.translationY), drags.value);
      } else {
        runOnJS(commitResize)(travel(end.translationY), drags.value);
      }
    })
    .onFinalize(() => {
      finish();
    });

  const tint = useEventTint(color);
  const animatedStyle = useAnimatedStyle(() => ({
    height: Math.max(height - 2 + extraHeight.value, SNAP_PX),
    shadowOpacity: lifted.value * 0.3,
    transform: [{ translateY: translateY.value }, { scale: 1 + lifted.value * 0.02 }],
    zIndex: translateY.value !== 0 || lifted.value > 0 ? 10 : 0,
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[
          styles.eventBlock,
          { backgroundColor: tint.fill, left, top, width },
          styles.eventShadow,
          animatedStyle,
        ]}
      >
        <Pressable onPress={onPress} style={styles.eventPressable}>
          <Text
            maxFontSizeMultiplier={BOX_FONT_SCALE}
            numberOfLines={compact ? 2 : 1}
            style={[styles.eventTitle, compact && styles.eventTitleCompact, { color: tint.text }]}
          >
            {event.title}
          </Text>
          {!compact && height > 34 ? (
            <Text
              maxFontSizeMultiplier={BOX_FONT_SCALE}
              numberOfLines={1}
              style={[styles.eventTime, { color: tint.text }]}
            >
              {formatClockTime(event.startUtc, timeZone)} –{' '}
              {formatClockTime(event.endUtc, timeZone)}
            </Text>
          ) : null}
          {!compact && secondaryZones.length > 0 && height > 52 ? (
            <Text
              maxFontSizeMultiplier={BOX_FONT_SCALE}
              numberOfLines={1}
              style={[styles.eventZones, { color: tint.text }]}
              testID="event-secondary-times"
            >
              {formatZoneRange(event.startUtc, event.endUtc, secondaryZones)}
            </Text>
          ) : null}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  eventBlock: {
    borderRadius: 6,
    position: 'absolute',
  },
  eventPressable: {
    flex: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
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
  eventZones: {
    fontSize: 9,
    opacity: 0.7,
  },
});
