import {
  BIRTHDAY_ACCENT,
  type BirthdayOccurrence,
  buildMonthGrid,
  calendarTaskKey,
  type EventRecord,
  groupByDate,
  groupEventsByDay,
  monthCellLabel,
  partitionCalendarTasks,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { palette } from './theme.ts';

const MAX_DOTS = 4;

// A cell's dots: the day's events, then birthdays, then tasks. Events lead
// because they carry the calendar's color and are what the grid showed
// before; there is no "+N more" here, so a day full of tasks must not
// push them out. Dots are read-only summaries — the cell opens the day,
// where the full chips with toggle and editor live.
type Dot = { readonly key: string; readonly style: ViewStyle };

export function MonthGrid({
  birthdays,
  colorOf,
  events,
  listColorOf,
  onSelectDay,
  overdue,
  tasks,
  timeZone,
  today: todayIso,
  yearMonth,
}: {
  birthdays: ReadonlyArray<BirthdayOccurrence>;
  colorOf: (event: EventRecord) => string;
  events: ReadonlyArray<EventRecord>;
  listColorOf: (task: TaskRecord) => string | undefined;
  onSelectDay: (date: Temporal.PlainDate) => void;
  /** Open tasks due before today; dotted on today's cell, not on their past day. */
  overdue: ReadonlyArray<TaskRecord>;
  tasks: ReadonlyArray<TaskRecord>;
  timeZone: string;
  today: string;
  yearMonth: Temporal.PlainYearMonth;
}) {
  const today = Temporal.PlainDate.from(todayIso);
  const weeks = buildMonthGrid(yearMonth, today);

  // One pass over each kind, not one filter + sort per cell.
  const eventsByDay = groupEventsByDay(
    events,
    weeks.flat().map((cell) => cell.date),
    timeZone,
  );
  const calendarTasks = partitionCalendarTasks([...tasks, ...overdue], todayIso);
  const tasksByDay = groupByDate(
    calendarTasks.allDay.concat(calendarTasks.timed),
    (task) => task.dueDate,
  );
  const overdueKeys = new Set(calendarTasks.overdue.map(calendarTaskKey));
  const birthdaysByDay = groupByDate(birthdays, (birthday) => birthday.date);

  // An outlined ring, like the lane's checkbox glyph: a task is not a
  // calendar color. The ring takes the Reminders list color where the lane
  // draws that accent; Google lists stay neutral. Done tasks fade; an
  // overdue task on today's cell rings red like its chip.
  const taskDot = (task: TaskRecord): ViewStyle => ({
    backgroundColor: 'transparent',
    borderColor:
      task.status === 'completed'
        ? palette.textFaint
        : overdueKeys.has(calendarTaskKey(task))
          ? palette.overdue
          : (listColorOf(task) ?? '#525252'),
    borderWidth: 1,
  });

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
            const dayEvents = eventsByDay.get(iso) ?? [];
            const dayBirthdays = birthdaysByDay.get(iso) ?? [];
            const dayTasks = (isToday ? calendarTasks.overdue : []).concat(
              tasksByDay.get(iso) ?? [],
            );
            const dots: Array<Dot> = [
              ...dayEvents.map((event) => ({
                key: `${event.calendarId}:${event.id}`,
                style: { backgroundColor: colorOf(event) },
              })),
              ...dayBirthdays.map((birthday) => ({
                key: `birthday:${birthday.record.id}`,
                style: styles.birthdayDot,
              })),
              ...dayTasks.map((task) => ({
                key: calendarTaskKey(task),
                style: taskDot(task),
              })),
            ];
            return (
              <Pressable
                accessibilityLabel={monthCellLabel(date, {
                  birthdays: dayBirthdays.length,
                  events: dayEvents.length,
                  tasks: dayTasks.length,
                })}
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
