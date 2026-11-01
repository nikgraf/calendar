import {
  type CalendarInfo,
  calendarKey,
  type SearchQuery,
  type TaskListInfo,
  toggleSearchKey,
  withoutSearchFilter,
} from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { dateForPicker, dateStringFromPicker } from './pickerDates.ts';
import { SegmentedControl } from './SegmentedControl.tsx';
import { actionText, BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from './theme.ts';

/**
 * The search's filters, edited by hand: when, which kind, all-day or
 * timed, which calendars and lists, a place, people. Every control edits
 * the query at once (a chip edit, not a turn); Done closes. A page sheet
 * like the app's other sheets.
 */
export function SearchFiltersSheet({
  calendars,
  onChange,
  onClose,
  query,
  taskLists,
  timeZone,
  today,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  onChange: (query: SearchQuery) => void;
  onClose: () => void;
  query: SearchQuery;
  taskLists: ReadonlyArray<TaskListInfo>;
  timeZone: string;
  today: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  // The people field as typed (commas and all); the query holds the names.
  const [peopleText, setPeopleText] = useState((query.people ?? []).join(', '));

  const day = (edge: 'from' | 'to', label: string) => {
    const value = query[edge];
    return (
      <View style={styles.row}>
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.rowLabel}>
          {label}
        </Text>
        {value === undefined ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => onChange({ ...query, [edge]: today })}
            testID={`search-filter-${edge}`}
          >
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.link}>
              Any
            </Text>
          </Pressable>
        ) : (
          <View style={styles.dayValue} testID={`search-filter-${edge}`}>
            <DateTimePicker
              display="compact"
              mode="date"
              onValueChange={(_, picked) =>
                onChange({ ...query, [edge]: dateStringFromPicker(picked, timeZone) })
              }
              timeZoneName={timeZone}
              value={dateForPicker(value, undefined, timeZone)}
            />
            <Pressable
              accessibilityLabel={`Any ${label.toLowerCase()} day`}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => {
                const { [edge]: _gone, ...rest } = query;
                onChange(rest);
              }}
            >
              <Text style={styles.remove}>×</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  };

  const option = (
    label: string,
    selected: boolean,
    onPress: () => void,
    testID: string,
    key: string,
  ) => (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      key={key}
      onPress={onPress}
      style={styles.option}
      testID={testID}
    >
      <Text maxFontSizeMultiplier={BOX_FONT_SCALE} numberOfLines={1} style={styles.optionLabel}>
        {label}
      </Text>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  );

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <View style={styles.container} testID="search-filters-sheet">
        <SafeAreaView edges={['top']}>
          <View style={styles.header}>
            <View style={styles.headerSide} />
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.title}>
              Filters
            </Text>
            <Pressable onPress={onClose} style={styles.headerSide} testID="search-filters-done">
              <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.done}>
                Done
              </Text>
            </Pressable>
          </View>
        </SafeAreaView>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.section}>When</Text>
          {day('from', 'From')}
          {day('to', 'To')}

          <Text style={styles.section}>Show</Text>
          <SegmentedControl
            accessibilityLabel="Events or tasks"
            grow
            onChange={(value: 'any' | 'event' | 'task') =>
              onChange(
                value === 'any' ? withoutSearchFilter(query, 'kind') : { ...query, kind: value },
              )
            }
            options={[
              { label: 'Both', testID: 'search-filter-kind-any', value: 'any' },
              { label: 'Events', testID: 'search-filter-kind-event', value: 'event' },
              { label: 'Tasks', testID: 'search-filter-kind-task', value: 'task' },
            ]}
            value={query.kind ?? 'any'}
          />
          <SegmentedControl
            accessibilityLabel="All-day or timed"
            grow
            onChange={(value: 'allDay' | 'any' | 'timed') =>
              onChange(
                value === 'any'
                  ? withoutSearchFilter(query, 'allDay')
                  : { ...query, allDay: value === 'allDay' },
              )
            }
            options={[
              { label: 'Any time of day', testID: 'search-filter-allday-any', value: 'any' },
              { label: 'All-day', testID: 'search-filter-allday-allDay', value: 'allDay' },
              { label: 'Timed', testID: 'search-filter-allday-timed', value: 'timed' },
            ]}
            value={query.allDay === undefined ? 'any' : query.allDay ? 'allDay' : 'timed'}
          />

          <Text style={styles.section}>Calendars</Text>
          {calendars
            .filter((calendar) => calendar.isVisible)
            .map((calendar) => {
              const key = calendarKey(calendar);
              return option(
                calendar.summary,
                query.calendars?.includes(key) ?? false,
                () => {
                  const next = toggleSearchKey(query.calendars, key);
                  onChange(
                    next.length > 0
                      ? { ...query, calendars: next }
                      : withoutSearchFilter(query, 'calendar'),
                  );
                },
                'search-filter-calendar-option',
                key,
              );
            })}

          <Text style={styles.section}>Lists</Text>
          {taskLists
            .filter((list) => list.isVisible)
            .map((list) => {
              const key = `${list.accountId}:${list.id}`;
              return option(
                list.title,
                query.lists?.includes(key) ?? false,
                () => {
                  const next = toggleSearchKey(query.lists, key);
                  onChange(
                    next.length > 0
                      ? { ...query, lists: next }
                      : withoutSearchFilter(query, 'list'),
                  );
                },
                'search-filter-list-option',
                key,
              );
            })}

          <Text style={styles.section}>Place</Text>
          <TextInput
            accessibilityLabel="Place"
            autoCapitalize="none"
            onChangeText={(value) =>
              onChange(
                value.trim()
                  ? { ...query, location: value }
                  : withoutSearchFilter(query, 'location'),
              )
            }
            placeholder="A place the event is at"
            placeholderTextColor={colors['text-secondary']}
            style={styles.input}
            testID="search-filter-location"
            value={query.location ?? ''}
          />
          <Text style={styles.section}>People</Text>
          <TextInput
            accessibilityLabel="People"
            autoCapitalize="none"
            onChangeText={(value) => {
              setPeopleText(value);
              const people = value
                .split(',')
                .map((person) => person.trim())
                .filter((person) => person !== '');
              onChange(
                people.length > 0 ? { ...query, people } : withoutSearchFilter(query, 'people'),
              );
            }}
            placeholder="Names or addresses, comma-separated"
            placeholderTextColor={colors['text-secondary']}
            style={styles.input}
            testID="search-filter-people"
            value={peopleText}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    check: {
      color: colors.primary,
      fontSize: 16,
      fontWeight: '700',
    },
    container: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    content: {
      gap: 8,
      paddingBottom: 48,
      paddingHorizontal: 16,
    },
    dayValue: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
    },
    done: {
      ...actionText(colors),
      fontSize: 16,
      textAlign: 'right',
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    headerSide: {
      minWidth: 56,
    },
    input: {
      backgroundColor: colors.fill,
      borderRadius: 8,
      color: colors.text,
      fontSize: 16,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    link: {
      ...actionText(colors),
      fontSize: 16,
    },
    option: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 8,
    },
    optionLabel: {
      color: colors.text,
      flex: 1,
      fontSize: 16,
    },
    remove: {
      color: colors['text-secondary'],
      fontSize: 18,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 40,
    },
    rowLabel: {
      color: colors.text,
      fontSize: 16,
    },
    section: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontWeight: '600',
      marginTop: 12,
      textTransform: 'uppercase',
    },
    title: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '700',
    },
  });
