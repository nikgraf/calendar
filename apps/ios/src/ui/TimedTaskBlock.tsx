import {
  formatPlainTime,
  priorityMarker,
  REPEAT_MARKER,
  type TaskRecord,
  taskRepeats,
} from '@calendar/core';
import { Pressable, StyleSheet, Text, View, type DimensionValue } from 'react-native';
import { GestureDetector, type PanGesture } from 'react-native-gesture-handler';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/**
 * A compact Apple Reminder with no duration. Its body long-presses into the
 * timeline's task drag (`gesture`): a ghost follows the finger to another
 * slot, another day, or up into the all-day lane, and the block dims until
 * the drop lands.
 */
export function TimedTaskBlock({
  compact,
  dimmed,
  gesture,
  left,
  listColor,
  onPress,
  onToggle,
  task,
  top,
  width,
}: {
  compact: boolean;
  /** This block is the one being dragged. */
  dimmed: boolean;
  gesture: PanGesture;
  left: DimensionValue;
  listColor: string | undefined;
  onPress: () => void;
  onToggle: () => void;
  task: TaskRecord;
  top: number;
  width: DimensionValue;
}) {
  const styles = useStyles(makeStyles);
  const done = task.status === 'completed';
  const marker = priorityMarker(task.priority);
  const repeats = taskRepeats(task);
  const label = `${marker ? `${marker} ` : ''}${task.title}${repeats ? ` ${REPEAT_MARKER}` : ''}`;
  const dueLabel = formatPlainTime(task.dueTime!);

  return (
    <View
      style={[styles.block, { left, top, width }, done && styles.done, dimmed && styles.dimmed]}
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
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.checkbox}>
          {done ? '☑' : '☐'}
        </Text>
      </Pressable>
      {listColor ? <View style={[styles.listDot, { backgroundColor: listColor }]} /> : null}
      <GestureDetector gesture={gesture}>
        <Pressable
          accessibilityLabel={`${task.title}, due ${dueLabel}${repeats ? ', repeats' : ''}`}
          accessibilityRole="button"
          hitSlop={4}
          onPress={onPress}
          style={styles.body}
          testID={`timed-task-body-${task.id}`}
        >
          <Text
            maxFontSizeMultiplier={BOX_FONT_SCALE}
            numberOfLines={1}
            style={[styles.title, compact && styles.titleCompact, done && styles.titleDone]}
          >
            {label}
          </Text>
        </Pressable>
      </GestureDetector>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    block: {
      alignItems: 'center',
      backgroundColor: colors.fill,
      borderRadius: 5,
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
      color: colors['text-secondary'],
      fontSize: 12,
    },
    dimmed: {
      opacity: 0.3,
    },
    done: {
      opacity: 0.5,
    },
    listDot: {
      borderRadius: 3,
      height: 6,
      marginRight: 4,
      width: 6,
    },
    title: {
      color: colors.text,
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
