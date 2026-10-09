import {
  type AgendaItem,
  type BirthdayOccurrence,
  birthdayChipLabel,
  buildAgenda,
  calendarTaskKey,
  type EventRecord,
  formatClockTime,
  formatPlainTime,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { useMemo } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { type ThemeColors, useEventTint, useStyles } from './theme.ts';

/**
 * The agenda: two weeks from the focused day as a list, one section per
 * day — all-day items first, then the timed ones in order. A free day
 * stays in the list so it reads as free. Rows open what the grid would.
 */
export function AgendaView({
  birthdays,
  colorOf,
  days,
  events,
  onBirthdayPress,
  onEventPress,
  onTaskPress,
  onToggleTask,
  overdue,
  tasks,
  timeZone,
  today,
}: {
  birthdays: ReadonlyArray<BirthdayOccurrence>;
  colorOf: (event: EventRecord) => string;
  days: ReadonlyArray<Temporal.PlainDate>;
  events: ReadonlyArray<EventRecord>;
  onBirthdayPress: (birthday: BirthdayOccurrence) => void;
  onEventPress: (event: EventRecord) => void;
  onTaskPress: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  overdue: ReadonlyArray<TaskRecord>;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  today: string;
}) {
  const styles = useStyles(makeStyles);
  const sections = useMemo(
    () =>
      buildAgenda({
        birthdays,
        days,
        events,
        tasks: [...tasks, ...overdue],
        timeZone,
        today,
      }).map((day) => ({ data: [...day.items], date: day.date })),
    [birthdays, days, events, overdue, tasks, timeZone, today],
  );
  return (
    <SectionList
      contentContainerStyle={styles.content}
      keyExtractor={(item) =>
        item.kind === 'event'
          ? `event:${item.event.calendarId}:${item.event.id}`
          : item.kind === 'task'
            ? `task:${calendarTaskKey(item.task)}`
            : `birthday:${item.birthday.record.id}:${item.birthday.date}`
      }
      renderItem={({ item }) => (
        <AgendaRow
          colorOf={colorOf}
          item={item}
          onBirthdayPress={onBirthdayPress}
          onEventPress={onEventPress}
          onTaskPress={onTaskPress}
          onToggleTask={onToggleTask}
          timeZone={timeZone}
        />
      )}
      renderSectionHeader={({ section }) => {
        const date = Temporal.PlainDate.from(section.date);
        const isToday = section.date === today;
        return (
          <View style={styles.dayHeader}>
            <Text style={[styles.dayLabel, isToday && styles.dayLabelToday]}>
              {isToday
                ? 'Today'
                : date.toLocaleString('en-US', {
                    day: 'numeric',
                    month: 'short',
                    weekday: 'short',
                  })}
            </Text>
            {section.data.length === 0 ? <Text style={styles.free}>Nothing planned</Text> : null}
          </View>
        );
      }}
      sections={sections}
      stickySectionHeadersEnabled={false}
      testID="agenda-list"
    />
  );
}

function AgendaRow({
  colorOf,
  item,
  onBirthdayPress,
  onEventPress,
  onTaskPress,
  onToggleTask,
  timeZone,
}: {
  colorOf: (event: EventRecord) => string;
  item: AgendaItem;
  onBirthdayPress: (birthday: BirthdayOccurrence) => void;
  onEventPress: (event: EventRecord) => void;
  onTaskPress: (task: TaskRecord) => void;
  onToggleTask: (task: TaskRecord) => void;
  timeZone: string;
}) {
  const styles = useStyles(makeStyles);
  const tint = useEventTint(item.kind === 'event' ? colorOf(item.event) : '#4285f4');
  if (item.kind === 'event') {
    const { event } = item;
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => onEventPress(event)}
        style={[styles.row, { backgroundColor: tint.fill }]}
        testID="agenda-event"
      >
        <Text style={[styles.time, { color: tint.text }]}>
          {event.isAllDay ? 'all day' : formatClockTime(event.startUtc, timeZone)}
        </Text>
        <Text numberOfLines={1} style={[styles.title, { color: tint.text }]}>
          {event.title}
        </Text>
      </Pressable>
    );
  }
  if (item.kind === 'birthday') {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => onBirthdayPress(item.birthday)}
        style={[styles.row, styles.birthdayRow]}
        testID="agenda-birthday"
      >
        <Text numberOfLines={1} style={[styles.title, styles.birthdayText]}>
          {birthdayChipLabel(item.birthday)}
        </Text>
      </Pressable>
    );
  }
  const { task } = item;
  const done = task.status === 'completed';
  return (
    <View style={[styles.row, styles.taskRow]} testID="agenda-task">
      <Pressable
        accessibilityLabel={`Toggle ${task.title}`}
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => onToggleTask(task)}
      >
        <Text style={styles.checkbox}>{done ? '☑' : '☐'}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() => onTaskPress(task)}
        style={styles.taskBody}
      >
        {task.dueTime ? <Text style={styles.taskTime}>{formatPlainTime(task.dueTime)}</Text> : null}
        <Text numberOfLines={1} style={[styles.taskTitle, done && styles.taskDone]}>
          {task.title}
        </Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    birthdayRow: {
      backgroundColor: colors['event-blush'],
    },
    birthdayText: {
      color: colors['on-event-blush'],
    },
    checkbox: {
      color: colors['text-secondary'],
      fontSize: 16,
    },
    content: {
      gap: 6,
      paddingBottom: 96,
      paddingHorizontal: 16,
    },
    dayHeader: {
      alignItems: 'baseline',
      flexDirection: 'row',
      gap: 10,
      paddingBottom: 4,
      paddingTop: 16,
    },
    dayLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
    },
    dayLabelToday: {
      color: colors.primary,
    },
    free: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    row: {
      alignItems: 'center',
      borderRadius: 8,
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    taskBody: {
      alignItems: 'center',
      flex: 1,
      flexDirection: 'row',
      gap: 10,
    },
    taskDone: {
      color: colors['text-secondary'],
      textDecorationLine: 'line-through',
    },
    taskRow: {
      backgroundColor: colors.fill,
    },
    taskTime: {
      color: colors['text-secondary'],
      fontSize: 13,
      minWidth: 64,
    },
    taskTitle: {
      color: colors.text,
      flex: 1,
      fontSize: 15,
    },
    // A column at the default size; at larger ones it widens instead of
    // breaking "8:00 AM" across lines.
    time: {
      fontSize: 13,
      minWidth: 64,
    },
    title: {
      flex: 1,
      fontSize: 15,
      fontWeight: '500',
    },
  });
