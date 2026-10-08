import { useBirthdayOverrideEditor } from '@calendar/app-state';
import {
  BIRTHDAY_LEAD_DAYS,
  type BirthdayOccurrence,
  type BirthdayRecord,
  describeBirthday,
  leadDaysLabel,
  Temporal,
} from '@calendar/core';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { chip, chipLabel, useSheetStyles } from './editSheetShared.ts';
import { type ThemeColors, useStyles } from './theme.ts';

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

/**
 * This person's reminder lead days as toggle chips: the general ones
 * until a chip is changed, then their own (saved at once). "Use defaults"
 * hands them back to the general list.
 */
function BirthdayReminders({ record }: { record: BirthdayRecord }) {
  const sheetStyles = useSheetStyles();
  const styles = useStyles(makeStyles);
  const editor = useBirthdayOverrideEditor(record);
  const [error, setError] = useState<string | null>(null);
  if (!editor.loaded) {
    return null;
  }
  const run = (save: Promise<void>) =>
    void save.then(
      () => setError(null),
      (error: unknown) => setError(String(error)),
    );
  return (
    <View testID="birthday-override">
      <View style={styles.remindersHeader}>
        <Text style={sheetStyles.label}>REMINDERS</Text>
        {editor.overridden ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => run(editor.reset())}
            testID="birthday-override-reset"
          >
            <Text style={styles.reset}>Use defaults</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={sheetStyles.scopeRow}>
        {BIRTHDAY_LEAD_DAYS.map((lead) => {
          const selected = editor.leadDays.includes(lead);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={lead}
              onPress={() => run(editor.toggle(lead))}
              style={chip(sheetStyles, selected)}
              // The suffix lets the e2e flow assert the state without a query.
              testID={`birthday-override-${String(lead)}${selected ? '-on' : ''}`}
            >
              <Text style={chipLabel(sheetStyles, selected)}>{leadDaysLabel(lead)}</Text>
            </Pressable>
          );
        })}
      </View>
      {editor.enabled ? null : (
        <Text style={sheetStyles.readOnlyNote} testID="birthday-reminders-off">
          Birthday reminders are off — turn them on in Settings.
        </Text>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

/** The birthday half of EventEditSheet: who, when, which address book, and its reminders. */
export function BirthdayDetail({
  occurrence,
  timeZone,
}: {
  occurrence: BirthdayOccurrence;
  timeZone: string;
}) {
  const sheetStyles = useSheetStyles();
  const styles = useStyles(makeStyles);
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
      <BirthdayReminders record={record} />
      <Text style={sheetStyles.readOnlyNote}>
        Birthdays are read-only here — edit them in Contacts or Google Contacts.
      </Text>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    countdown: {
      color: colors['text-secondary'],
      fontSize: 14,
      marginBottom: 16,
    },
    date: {
      color: colors.text,
      fontSize: 15,
      marginBottom: 6,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      marginBottom: 8,
    },
    name: {
      color: colors.text,
      fontSize: 20,
      fontWeight: '600',
      marginBottom: 6,
    },
    remindersHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    reset: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: '600',
    },
    source: {
      color: colors.text,
      fontSize: 14,
      paddingVertical: 4,
    },
    sources: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      marginBottom: 12,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
  });
