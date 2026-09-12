import {
  BIRTHDAY_ACCENT,
  type BirthdayOccurrence,
  birthdayChipLabel,
  type EventRecord,
  taskChipLabel,
  type TaskRecord,
} from '@calendar/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { chipTextColor, palette } from './theme.ts';
import { ALL_DAY_ROW_HEIGHT } from './timelineLayout.ts';

/**
 * One day's all-day chips (due tasks, then birthdays, then events), one
 * chip per row. Past `maxChips` the column shows the first rows and a
 * "+N more" chip that expands the lane.
 */
export function AllDayColumn({
  birthdays,
  colorOf,
  compact,
  events,
  listColorOf,
  maxChips,
  onBirthdayPress,
  onEventPress,
  onShowMore,
  onTaskPress,
  onToggleTask,
  tasks,
  width,
}: {
  /** Birthdays falling on this day. */
  birthdays: ReadonlyArray<BirthdayOccurrence>;
  colorOf: (event: EventRecord) => string;
  compact: boolean;
  /** All-day events on this day. */
  events: ReadonlyArray<EventRecord>;
  listColorOf: (task: TaskRecord) => string | undefined;
  maxChips: number;
  onBirthdayPress: (birthday: BirthdayOccurrence) => void;
  onEventPress: (event: EventRecord) => void;
  onShowMore: () => void;
  onTaskPress: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  /** Tasks due on this day. */
  tasks: ReadonlyArray<TaskRecord>;
  width: number;
}) {
  const total = tasks.length + birthdays.length + events.length;
  // A column that fits shows everything; one that overflows gives its
  // last row to the "+N more" chip.
  const limit = total > maxChips ? maxChips - 1 : total;
  const visibleTasks = tasks.slice(0, limit);
  const visibleBirthdays = birthdays.slice(0, Math.max(limit - visibleTasks.length, 0));
  const visibleEvents = events.slice(
    0,
    Math.max(limit - visibleTasks.length - visibleBirthdays.length, 0),
  );
  const hidden = total - visibleTasks.length - visibleBirthdays.length - visibleEvents.length;
  return (
    <View style={[styles.allDayColumn, { width }]}>
      {visibleTasks.map((task) => {
        const done = task.status === 'completed';
        const listColor = listColorOf(task);
        return (
          <View
            key={`task:${task.listId}:${task.id}`}
            style={[
              styles.allDayChip,
              styles.taskChip,
              // Reminders lists have colors; a left accent tells them apart
              // from Google tasks without recoloring the whole chip.
              listColor ? { borderLeftColor: listColor, borderLeftWidth: 3 } : null,
              done && styles.taskChipDone,
            ]}
            testID={`task-chip-${task.id}`}
          >
            {/* Side-by-side Pressables — no nested-press arbitration. The
                labels double as stable e2e handles: a created task's id
                swaps from local- to the server id as soon as its op
                pushes, so id-based selectors go stale mid-flow — the
                title does not. */}
            <Pressable
              accessibilityLabel={`Toggle ${task.title}`}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => onToggleTask(task)}
              testID={`task-chip-toggle-${task.id}`}
            >
              <Text style={styles.taskCheckbox}>{done ? '☑' : '☐'}</Text>
            </Pressable>
            <Pressable
              hitSlop={4}
              onPress={() => onTaskPress(task)}
              style={styles.taskBody}
              testID={`task-chip-body-${task.id}`}
            >
              <Text
                numberOfLines={1}
                style={[
                  styles.allDayText,
                  compact && styles.allDayTextCompact,
                  styles.taskText,
                  done && styles.taskTextDone,
                ]}
              >
                {taskChipLabel(task)}
              </Text>
            </Pressable>
          </View>
        );
      })}
      {visibleBirthdays.map((birthday) => {
        const label = birthdayChipLabel(birthday);
        // Birthdays carry no calendar color: the neutral task treatment
        // with a fixed accent says "not an event".
        return (
          <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            hitSlop={4}
            key={`birthday:${birthday.record.id}`}
            onPress={() => onBirthdayPress(birthday)}
            style={[styles.allDayChip, styles.taskChip, styles.birthdayChip]}
            testID="birthday-chip"
          >
            <Text
              numberOfLines={1}
              style={[styles.allDayText, compact && styles.allDayTextCompact, styles.taskText]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
      {visibleEvents.map((event) => {
        const color = colorOf(event);
        // A Pressable like the task chip body: an all-day event opens
        // its editor on the phone the way it does on desktop.
        return (
          <Pressable
            accessibilityLabel={event.title}
            accessibilityRole="button"
            hitSlop={4}
            key={`${event.calendarId}:${event.id}`}
            onPress={() => onEventPress(event)}
            style={[styles.allDayChip, { backgroundColor: color }]}
            testID="all-day-event-chip"
          >
            <Text
              numberOfLines={1}
              style={[
                styles.allDayText,
                compact && styles.allDayTextCompact,
                { color: chipTextColor(color) },
              ]}
            >
              {event.title}
            </Text>
          </Pressable>
        );
      })}
      {hidden > 0 ? (
        <Pressable
          accessibilityLabel={`${String(hidden)} more all-day items, show all`}
          accessibilityRole="button"
          hitSlop={4}
          onPress={onShowMore}
          style={[styles.allDayChip, styles.moreChip]}
          testID="all-day-more"
        >
          <Text numberOfLines={1} style={[styles.allDayText, styles.moreText]}>
            +{hidden} more
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  allDayChip: {
    borderRadius: 5,
    height: ALL_DAY_ROW_HEIGHT - 4,
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  allDayColumn: {
    gap: 4,
    paddingHorizontal: 2,
    paddingVertical: 2,
  },
  allDayText: {
    fontSize: 13,
    fontWeight: '500',
  },
  allDayTextCompact: {
    fontSize: 11,
  },
  birthdayChip: {
    borderLeftColor: BIRTHDAY_ACCENT,
    borderLeftWidth: 3,
  },
  moreChip: {
    backgroundColor: '#f5f5f5',
  },
  moreText: {
    color: palette.textMuted,
    fontSize: 11,
  },
  taskBody: {
    flexShrink: 1,
  },
  taskCheckbox: {
    color: '#525252',
    fontSize: 12,
  },
  taskChip: {
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    borderColor: '#d4d4d4',
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 3,
  },
  taskChipDone: {
    opacity: 0.5,
  },
  taskText: {
    color: '#404040',
  },
  taskTextDone: {
    textDecorationLine: 'line-through',
  },
});
