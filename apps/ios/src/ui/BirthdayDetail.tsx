import { type BirthdayOccurrence, describeBirthday, Temporal } from '@calendar/core';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { sheetStyles } from './editSheetShared.ts';
import { palette } from './theme.ts';

// Through a PlainDate in a leap year: the polyfill cannot localise a
// PlainMonthDay ("cannot format PlainMonthDay with calendar iso8601"),
// and 2000 keeps Feb 29 formattable.
const monthDay = (record: { readonly day: number; readonly month: number }): string =>
  Temporal.PlainDate.from({ day: record.day, month: record.month, year: 2000 }).toLocaleString(
    'en-US',
    { day: 'numeric', month: 'long' },
  );

const countdown = (daysUntil: number, ageTurning: number | undefined): string => {
  const turns = ageTurning === undefined ? '' : ` — turns ${String(ageTurning)}`;
  if (daysUntil === 0) {
    return `Today${turns}`;
  }
  if (daysUntil === 1) {
    return `Tomorrow${turns}`;
  }
  return `In ${String(daysUntil)} days${turns}`;
};

/** The read-only birthday half of EventEditSheet: who, when, and which address book. */
export function BirthdayDetail({
  occurrence,
  timeZone,
}: {
  occurrence: BirthdayOccurrence;
  timeZone: string;
}) {
  const { record } = occurrence;
  const next = describeBirthday(record, Temporal.Now.plainDateISO(timeZone).toString());
  return (
    <ScrollView contentContainerStyle={sheetStyles.content} testID="birthday-detail">
      <Text selectable style={styles.name}>
        {record.displayName}
      </Text>
      <Text selectable style={styles.date}>
        🎂 {monthDay(record)}
        {record.year === undefined ? '' : ` · born ${String(record.year)}`}
      </Text>
      <Text style={styles.countdown}>{countdown(next.daysUntil, next.ageTurning)}</Text>
      <Text style={sheetStyles.label}>SOURCE</Text>
      <View style={styles.sources}>
        {record.sources.map((source) => (
          <Text key={source.id} selectable style={styles.source} testID="birthday-source">
            {source.source === 'google'
              ? `Google contact${source.accountEmail ? ` · ${source.accountEmail}` : ''}`
              : 'Device contact (this phone)'}
          </Text>
        ))}
      </View>
      <Text style={sheetStyles.readOnlyNote}>
        Birthdays are read-only here — edit them in Contacts or Google Contacts.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  countdown: {
    color: palette.textMuted,
    fontSize: 14,
    marginBottom: 16,
  },
  date: {
    color: palette.text,
    fontSize: 15,
    marginBottom: 6,
  },
  name: {
    color: palette.text,
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 6,
  },
  source: {
    color: palette.text,
    fontSize: 14,
    paddingVertical: 4,
  },
  sources: {
    backgroundColor: '#ffffff',
    borderColor: palette.border,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});
