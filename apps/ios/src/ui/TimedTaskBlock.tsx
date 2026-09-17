/* eslint-disable react/immutability -- Reanimated shared values are mutable refs by design. */
import { formatPlainTime, priorityMarker, type TaskRecord } from '@calendar/core';
import { Pressable, StyleSheet, Text, type DimensionValue } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { palette } from './theme.ts';
import { pxToMinutes, SNAP_PX } from './timelineLayout.ts';

/** A compact Apple Reminder that moves in 15-minute steps and has no duration. */
export function TimedTaskBlock({
  compact,
  left,
  listColor,
  onCommitMove,
  onPress,
  onToggle,
  readOnly,
  task,
  top,
  width,
}: {
  compact: boolean;
  left: DimensionValue;
  listColor: string | undefined;
  onCommitMove: (deltaMinutes: number) => void;
  onPress: () => void;
  onToggle: () => void;
  readOnly: boolean;
  task: TaskRecord;
  top: number;
  width: DimensionValue;
}) {
  const translateY = useSharedValue(0);
  const lifted = useSharedValue(0);
  const done = task.status === 'completed';
  const marker = priorityMarker(task.priority);
  const label = `${marker ? `${marker} ` : ''}${task.title}`;
  const dueLabel = formatPlainTime(task.dueTime!);

  const commitMove = (translationPx: number) => {
    translateY.value = 0;
    lifted.value = 0;
    const deltaMinutes = pxToMinutes(translationPx);
    if (Math.round(deltaMinutes / 15) !== 0) {
      onCommitMove(deltaMinutes);
    }
  };

  const movePan = Gesture.Pan()
    .enabled(!readOnly)
    .activateAfterLongPress(250)
    .onStart(() => {
      lifted.value = withTiming(1, { duration: 120 });
    })
    .onUpdate((update) => {
      translateY.value = Math.round(update.translationY / SNAP_PX) * SNAP_PX;
    })
    .onEnd((end, success) => {
      if (success) {
        runOnJS(commitMove)(end.translationY);
      }
    })
    .onFinalize(() => {
      translateY.value = withTiming(0, { duration: 120 });
      lifted.value = withTiming(0, { duration: 120 });
    });

  const animatedStyle = useAnimatedStyle(() => ({
    shadowOpacity: lifted.value * 0.3,
    transform: [{ translateY: translateY.value }, { scale: 1 + lifted.value * 0.02 }],
    zIndex: translateY.value !== 0 || lifted.value > 0 ? 10 : 0,
  }));

  return (
    <Animated.View
      style={[
        styles.block,
        styles.shadow,
        { left, top, width },
        listColor ? { borderLeftColor: listColor, borderLeftWidth: 3 } : null,
        done && styles.done,
        animatedStyle,
      ]}
      testID={`timed-task-${task.id}`}
    >
      <Pressable
        accessibilityLabel={
          done ? `Reopen reminder ${task.title}` : `Complete reminder ${task.title}`
        }
        accessibilityRole="button"
        hitSlop={8}
        onPress={onToggle}
        testID={`timed-task-toggle-${task.id}`}
      >
        <Text style={styles.checkbox}>{done ? '☑' : '☐'}</Text>
      </Pressable>
      <GestureDetector gesture={movePan}>
        <Pressable
          accessibilityLabel={`${task.title}, due ${dueLabel}`}
          accessibilityRole="button"
          hitSlop={4}
          onPress={onPress}
          style={styles.body}
          testID={`timed-task-body-${task.id}`}
        >
          <Text
            numberOfLines={1}
            style={[styles.title, compact && styles.titleCompact, done && styles.titleDone]}
          >
            {label}
          </Text>
        </Pressable>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  block: {
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    borderColor: '#d4d4d4',
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 3,
    height: 22,
    paddingHorizontal: 4,
    position: 'absolute',
  },
  body: {
    flex: 1,
  },
  checkbox: {
    color: '#525252',
    fontSize: 12,
  },
  done: {
    opacity: 0.5,
  },
  shadow: {
    shadowColor: '#000000',
    shadowOffset: { height: 4, width: 0 },
    shadowRadius: 8,
  },
  title: {
    color: palette.text,
    fontSize: 13,
    fontWeight: '500',
  },
  titleCompact: {
    fontSize: 11,
  },
  titleDone: {
    textDecorationLine: 'line-through',
  },
});
