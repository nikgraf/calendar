import {
  BIRTHDAY_ACCENT,
  type BirthdayOccurrence,
  buildMonthGrid,
  type EventRecord,
  groupByDate,
  groupEventsByDay,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { palette } from './theme.ts';

const MAX_DOTS = 4;

// A cell's dots in the all-day lane's order: tasks, birthdays, then the
// day's events. Dots are read-only summaries — the cell opens the day,
// where the full chips with toggle and editor live.
type Dot = { readonly key: string; readonly style: object };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function MonthGrid({
  birthdays,
  colorOf,
  events,
  onSelectDay,
  tasks,
  timeZone,
  yearMonth,
}: {
  birthdays: ReadonlyArray<BirthdayOccurrence>;
  colorOf: (event: EventRecord) => string;
  events: ReadonlyArray<EventRecord>;
  onSelectDay: (date: Temporal.PlainDate) => void;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  yearMonth: Temporal.PlainYearMonth;
}) {
  const today = Temporal.Now.plainDateISO(timeZone);
  const weeks = buildMonthGrid(yearMonth, today);

  // One pass over each kind, not one filter + sort per cell.
  const eventsByDay = groupEventsByDay(
    events,
    weeks.flat().map((cell) => cell.date),
    timeZone,
  );
  const tasksByDay = groupByDate(tasks, (task) => task.dueDate);
  const birthdaysByDay = groupByDate(birthdays, (birthday) => birthday.date);

  return (
    <View style={styles.container}>
      <View style={styles.weekdayRow}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((label, index) => (
          <Text key={index} style={styles.weekdayLabel}>
            {label}
          </Text>
        ))}
      </View>
      {weeks.map((week, weekIndex) => (
        <View key={weekIndex} style={styles.weekRow}>
          {week.map(({ date, inMonth, isToday }) => {
            const iso = date.toString();
            const dayTasks = tasksByDay.get(iso) ?? [];
            const dayBirthdays = birthdaysByDay.get(iso) ?? [];
            const dayEvents = eventsByDay.get(iso) ?? [];
            const dots: Array<Dot> = [
              ...dayTasks.map((task) => ({
                key: `task:${task.listId}:${task.id}`,
                style: task.status === 'completed' ? styles.taskDotDone : styles.taskDot,
              })),
              ...dayBirthdays.map((birthday) => ({
                key: `birthday:${birthday.record.id}`,
                style: styles.birthdayDot,
              })),
              ...dayEvents.map((event) => ({
                key: `${event.calendarId}:${event.id}`,
                style: { backgroundColor: colorOf(event) },
              })),
            ];
            // Events always announced (the label read that way before); the
            // other kinds only when present.
            const counts = [
              plural(dayEvents.length, 'event'),
              dayTasks.length > 0 ? plural(dayTasks.length, 'task') : null,
              dayBirthdays.length > 0 ? plural(dayBirthdays.length, 'birthday') : null,
            ].filter((part) => part !== null);
            return (
              <Pressable
                accessibilityLabel={`${date.toLocaleString('en-US', {
                  day: 'numeric',
                  month: 'long',
                  weekday: 'long',
                })}, ${counts.join(', ')}`}
                accessibilityRole="button"
                key={iso}
                onPress={() => onSelectDay(date)}
                style={styles.dayCell}
              >
                <View style={[styles.dayNumberWrap, isToday && styles.todayWrap]}>
                  <Text
                    style={[
                      styles.dayNumber,
                      !inMonth && styles.outsideMonth,
                      isToday && styles.todayText,
                    ]}
                  >
                    {date.day}
                  </Text>
                </View>
                <View style={styles.dotsRow}>
                  {dots.slice(0, MAX_DOTS).map((dot) => (
                    <View key={dot.key} style={[styles.dot, dot.style]} />
                  ))}
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  birthdayDot: {
    backgroundColor: BIRTHDAY_ACCENT,
  },
  container: {
    flex: 1,
    paddingHorizontal: 4,
  },
  dayCell: {
    alignItems: 'center',
    flex: 1,
    gap: 3,
    paddingVertical: 10,
  },
  dayNumber: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '500',
  },
  dayNumberWrap: {
    alignItems: 'center',
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  dot: {
    borderRadius: 2.5,
    height: 5,
    width: 5,
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 3,
    height: 6,
  },
  outsideMonth: {
    color: palette.textFaint,
  },
  // Outlined, like the lane's checkbox glyph: a task is not a calendar
  // color. Done tasks fade the way the lane's chip does.
  taskDot: {
    backgroundColor: 'transparent',
    borderColor: '#525252',
    borderWidth: 1,
  },
  taskDotDone: {
    backgroundColor: 'transparent',
    borderColor: '#a3a3a3',
    borderWidth: 1,
  },
  todayText: {
    color: '#ffffff',
  },
  todayWrap: {
    backgroundColor: palette.today,
  },
  weekdayLabel: {
    color: palette.textFaint,
    flex: 1,
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
  weekdayRow: {
    flexDirection: 'row',
    paddingVertical: 6,
  },
  weekRow: {
    flexDirection: 'row',
  },
});
