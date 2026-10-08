/* eslint-disable react/immutability -- Reanimated shared values are mutable
   refs by design (`.value =` is the API); the React Compiler lint cannot tell
   them from hook state. */
import { type EventRecord, formatClockTime, formatZoneRange } from '@calendar/core';
import { useLayoutEffect } from 'react';
import { Pressable, StyleSheet, Text, View, type DimensionValue } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useEventTint } from './theme.ts';
import { pxToMinutes, SNAP_PX } from './timelineLayout.ts';

/**
 * How long a dropped block waits for its write to redraw it before it goes
 * back: a failed write (a toast says so) changes nothing.
 */
const DROP_SETTLE_MS = 1500;

/** The pan that owns a drag: the whole block moves it, the bottom edge resizes it. */
const MOVE = 1;
const RESIZE = 2;

/**
 * A timed event in a timeline column: long-press-drag moves it (15-minute
 * snap), a long press on the bottom edge resizes it, a tap opens it.
 */
export function DraggableEventBlock({
  color,
  compact,
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
  // The pan that owns the drag under way, MOVE or RESIZE (0 for none, and
  // while a pan waits for `held`). Only the owner updates, commits and ends
  // it: a hold on the bottom edge also starts the move pan, which fails once
  // the resize takes the touch and still finalizes.
  const dragging = useSharedValue(0);
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
  const begin = (pan: number) => {
    'worklet';
    if (held.value === 1 || dragging.value !== 0) {
      return;
    }
    dragging.value = pan;
    drags.value += 1;
    lifted.value = withTiming(1, { duration: 120 });
  };
  const finish = (pan: number) => {
    'worklet';
    if (dragging.value === pan) {
      dragging.value = 0;
      lifted.value = withTiming(0, { duration: 120 });
    }
  };
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

  // Held first, like a move: a pan that took the bottom edge at once won
  // the touch from the ScrollView, and on a short block the edge is much
  // of the block.
  const resizePan = Gesture.Pan()
    .enabled(draggable)
    .activateAfterLongPress(250)
    .onStart(() => {
      begin(RESIZE);
    })
    .onUpdate((update) => {
      if (dragging.value === RESIZE) {
        extraHeight.value = Math.round(update.translationY / SNAP_PX) * SNAP_PX;
      }
    })
    .onEnd((end, success) => {
      if (dragging.value !== RESIZE) {
        return;
      }
      // A cancelled pan (the system took the touch) changes nothing.
      if (success) {
        held.value = 1;
        runOnJS(commitResize)(end.translationY, drags.value);
      } else {
        goBack(drags.value);
      }
    })
    .onFinalize(() => {
      finish(RESIZE);
    });

  const movePan = Gesture.Pan()
    .enabled(draggable)
    .activateAfterLongPress(250)
    // A hold on the bottom edge is a resize.
    .requireExternalGestureToFail(resizePan)
    .onStart(() => {
      begin(MOVE);
    })
    .onUpdate((update) => {
      if (dragging.value === MOVE) {
        translateY.value = Math.round(update.translationY / SNAP_PX) * SNAP_PX;
      }
    })
    .onEnd((end, success) => {
      if (dragging.value !== MOVE) {
        return;
      }
      if (success) {
        held.value = 1;
        runOnJS(commitMove)(end.translationY, drags.value);
      } else {
        goBack(drags.value);
      }
    })
    .onFinalize(() => {
      finish(MOVE);
    });

  const tint = useEventTint(color);
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
          { backgroundColor: tint.fill, left, top, width },
          styles.eventShadow,
          animatedStyle,
        ]}
      >
        <Pressable onPress={onPress} style={styles.eventPressable}>
          <Text
            numberOfLines={compact ? 2 : 1}
            style={[styles.eventTitle, compact && styles.eventTitleCompact, { color: tint.text }]}
          >
            {event.title}
          </Text>
          {!compact && height > 34 ? (
            <Text numberOfLines={1} style={[styles.eventTime, { color: tint.text }]}>
              {formatClockTime(event.startUtc, timeZone)} –{' '}
              {formatClockTime(event.endUtc, timeZone)}
            </Text>
          ) : null}
          {!compact && secondaryZones.length > 0 && height > 52 ? (
            <Text
              numberOfLines={1}
              style={[styles.eventZones, { color: tint.text }]}
              testID="event-secondary-times"
            >
              {formatZoneRange(event.startUtc, event.endUtc, secondaryZones)}
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
  resizeHandle: {
    bottom: 0,
    height: 16,
    left: 0,
    position: 'absolute',
    right: 0,
  },
});
