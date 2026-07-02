import { buildMonthGrid, dayRange, Temporal, type EventRecord } from '@calendar/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { palette } from './theme.ts';

const MAX_DOTS = 4;

export function MonthGrid({
  colorOf,
  events,
  onSelectDay,
  timeZone,
  yearMonth,
}: {
  colorOf: (event: EventRecord) => string;
  events: ReadonlyArray<EventRecord>;
  onSelectDay: (date: Temporal.PlainDate) => void;
  timeZone: string;
  yearMonth: Temporal.PlainYearMonth;
}) {
  const today = Temporal.Now.plainDateISO(timeZone);
  const weeks = buildMonthGrid(yearMonth, today);

  const eventsForDay = (date: Temporal.PlainDate) => {
    const range = dayRange(date, timeZone);
    return events.filter((event) => event.startUtc < range.endUtc && event.endUtc > range.startUtc);
  };

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
            const dayEvents = eventsForDay(date);
            return (
              <Pressable
                key={date.toString()}
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
                  {dayEvents.slice(0, MAX_DOTS).map((event) => (
                    <View
                      key={`${event.calendarId}:${event.id}`}
                      style={[styles.dot, { backgroundColor: colorOf(event) }]}
                    />
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
