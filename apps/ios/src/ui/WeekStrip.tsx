import { Temporal } from '@calendar/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/** One weekday + day-number cell: the strip's picker cell and the week timeline's column header. */
export function WeekStripCell({
  day,
  isSelected,
  isToday,
  onPress,
  width,
}: {
  day: Temporal.PlainDate;
  isSelected: boolean;
  isToday: boolean;
  onPress: () => void;
  /** Fixed column width (the timeline header); the picker strip flexes instead. */
  width?: number;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      accessibilityLabel={day.toLocaleString('en-US', {
        day: 'numeric',
        month: 'long',
        weekday: 'long',
      })}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      onPress={onPress}
      style={[styles.cell, width === undefined ? styles.cellFlex : { width }]}
    >
      <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.weekday}>
        {day.toLocaleString('en-US', { weekday: 'narrow' })}
      </Text>
      <View
        style={[
          styles.dayWrap,
          isSelected && styles.selectedWrap,
          isToday && !isSelected && styles.todayWrap,
        ]}
      >
        <Text
          maxFontSizeMultiplier={BOX_FONT_SCALE}
          style={[styles.day, isToday && styles.todayText, isSelected && styles.selectedText]}
        >
          {day.day}
        </Text>
      </View>
    </Pressable>
  );
}

/** The day view's date picker: the focused day's week, one flexing cell per day. */
export function WeekStrip({
  days,
  onSelect,
  selected,
  timeZone,
}: {
  days: ReadonlyArray<Temporal.PlainDate>;
  onSelect: (date: Temporal.PlainDate) => void;
  selected: Temporal.PlainDate;
  timeZone: string;
}) {
  const styles = useStyles(makeStyles);
  const today = Temporal.Now.plainDateISO(timeZone);
  return (
    <View style={styles.row}>
      {days.map((day) => (
        <WeekStripCell
          day={day}
          isSelected={Temporal.PlainDate.compare(day, selected) === 0}
          isToday={Temporal.PlainDate.compare(day, today) === 0}
          key={day.toString()}
          onPress={() => onSelect(day)}
        />
      ))}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    cell: {
      alignItems: 'center',
      gap: 2,
    },
    cellFlex: {
      flex: 1,
    },
    day: {
      color: colors.text,
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
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      paddingBottom: 6,
      paddingHorizontal: 4,
    },
    selectedText: {
      color: colors['on-primary'],
    },
    selectedWrap: {
      backgroundColor: colors.text,
    },
    todayText: {
      color: colors.primary,
    },
    todayWrap: {
      borderColor: colors.primary,
      borderWidth: 1.5,
    },
    weekday: {
      color: colors['text-secondary'],
      fontSize: 10,
      fontWeight: '600',
    },
  });
