import { type EventRecord, formatClockTime } from '@calendar/core';
import { Pressable, StyleSheet, Text, View, type DimensionValue } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { chipTextColor } from './theme.ts';
import { pxToMinutes, SNAP_PX } from './timelineLayout.ts';

/**
 * A timed event in a timeline column: long-press-drag moves it (15-minute
 * snap), the bottom edge resizes, a tap opens it.
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
  resizeHandle: {
    bottom: 0,
    height: 16,
    left: 0,
    position: 'absolute',
    right: 0,
  },
});
