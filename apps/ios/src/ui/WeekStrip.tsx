import { Temporal } from '@calendar/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { palette } from './theme.ts';

export function WeekStrip({
  days,
  leadingInset = 0,
  onSelect,
  selected,
  timeZone,
  trailingInset = 0,
}: {
  days: ReadonlyArray<Temporal.PlainDate>;
  /** Width of the timeline's hour gutter, so week-view cells sit over their columns. */
  leadingInset?: number;
  onSelect: (date: Temporal.PlainDate) => void;
  selected: Temporal.PlainDate;
  timeZone: string;
  trailingInset?: number;
}) {
  const today = Temporal.Now.plainDateISO(timeZone);
  return (
    <View style={[styles.row, leadingInset > 0 && styles.rowAligned]}>
      {leadingInset > 0 ? <View style={{ width: leadingInset }} /> : null}
      {days.map((day) => {
        const isSelected = Temporal.PlainDate.compare(day, selected) === 0;
        const isToday = Temporal.PlainDate.compare(day, today) === 0;
        return (
          <Pressable
            accessibilityLabel={day.toLocaleString('en-US', {
              day: 'numeric',
              month: 'long',
              weekday: 'long',
            })}
            accessibilityRole="button"
            accessibilityState={{ selected: Temporal.PlainDate.compare(day, selected) === 0 }}
            key={day.toString()}
            onPress={() => onSelect(day)}
            style={styles.cell}
          >
            <Text style={styles.weekday}>{day.toLocaleString('en-US', { weekday: 'narrow' })}</Text>
            <View
              style={[
                styles.dayWrap,
                isSelected && styles.selectedWrap,
                isToday && !isSelected && styles.todayWrap,
              ]}
            >
              <Text
                style={[styles.day, isToday && styles.todayText, isSelected && styles.selectedText]}
              >
                {day.day}
              </Text>
            </View>
          </Pressable>
        );
      })}
      {trailingInset > 0 ? <View style={{ width: trailingInset }} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cell: {
    alignItems: 'center',
    flex: 1,
    gap: 2,
  },
  day: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '600',
  },
  dayWrap: {
    alignItems: 'center',
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  row: {
    borderBottomColor: palette.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingBottom: 6,
    paddingHorizontal: 4,
  },
  rowAligned: {
    paddingHorizontal: 0,
  },
  selectedText: {
    color: '#ffffff',
  },
  selectedWrap: {
    backgroundColor: palette.text,
  },
  todayText: {
    color: palette.today,
  },
  todayWrap: {
    borderColor: palette.today,
    borderWidth: 1.5,
  },
  weekday: {
    color: palette.textFaint,
    fontSize: 10,
    fontWeight: '600',
  },
});
