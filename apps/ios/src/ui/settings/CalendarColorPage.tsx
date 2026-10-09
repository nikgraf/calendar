import { useAccounts, useCalendars, useGuardedMutations } from '@calendar/app-state';
import { CALENDAR_PALETTE, isAppleCalendarAccount } from '@calendar/core';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { type ThemeColors, useStyles } from '../theme.ts';
import { Footer, Row, Section, SettingsPage } from './GroupedList.tsx';

/**
 * One calendar's color: the 24 palette swatches in a grid, the current
 * one ringed. A change syncs back to Google (or EventKit); a calendar the
 * Calendar app will not let us write keeps its color, and says why.
 */
export function CalendarColorPage() {
  const { accountId, calendarId } = useLocalSearchParams<{
    accountId: string;
    calendarId: string;
  }>();
  const styles = useStyles(makeStyles);
  const accounts = useAccounts();
  const calendars = useCalendars();
  const guarded = useGuardedMutations();
  const calendar = calendars.find(
    (candidate) => candidate.accountId === accountId && candidate.id === calendarId,
  );
  const account = accounts.find((candidate) => candidate.id === accountId);

  if (!calendar) {
    return (
      <SettingsPage testID="settings-page-calendar">
        <Footer>This calendar is no longer on this iPhone.</Footer>
      </SettingsPage>
    );
  }
  // EventKit refuses to recolor a calendar it will not let us write.
  const readOnly = calendar.provider === 'apple' && calendar.accessRole === 'reader';
  const apple = account !== undefined && isAppleCalendarAccount(account);
  const footer = readOnly
    ? 'Calendar does not let Solunivo change this calendar, so its color stays as it is.'
    : apple
      ? 'The color changes in the Calendar app too.'
      : 'The color changes in Google Calendar too.';

  return (
    <SettingsPage testID="settings-page-calendar">
      <Stack.Screen options={{ title: calendar.summary }} />
      <Section>
        <Row
          title="Account"
          value={apple ? (calendar.sourceTitle ?? 'On This iPhone') : (account?.email ?? '')}
        />
      </Section>
      <Section footer={footer} header="Color">
        <View
          accessibilityLabel="Calendar color"
          accessibilityRole="radiogroup"
          style={[styles.grid, readOnly && styles.disabled]}
        >
          {CALENDAR_PALETTE.map((hex, index) => {
            const selected = hex.toLowerCase() === calendar.colorHex.toLowerCase();
            return (
              <View key={hex} style={styles.cell}>
                <Pressable
                  accessibilityLabel={`Color ${String(index + 1)} of ${String(CALENDAR_PALETTE.length)}`}
                  accessibilityRole="radio"
                  accessibilityState={{ disabled: readOnly, selected }}
                  disabled={readOnly}
                  onPress={() =>
                    void guarded.setCalendarColor({
                      accountId: calendar.accountId,
                      calendarId: calendar.id,
                      colorHex: hex,
                    })
                  }
                  style={[styles.ring, selected && styles.ringSelected]}
                  testID={`calendar-swatch-${hex.slice(1)}${selected ? '-on' : ''}`}
                >
                  <View style={[styles.swatch, { backgroundColor: hex }]} />
                </Pressable>
              </View>
            );
          })}
        </View>
      </Section>
    </SettingsPage>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    cell: {
      alignItems: 'center',
      paddingVertical: 6,
      width: '16.666%',
    },
    disabled: {
      opacity: 0.4,
    },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingHorizontal: 10,
      paddingVertical: 12,
    },
    ring: {
      alignItems: 'center',
      borderColor: 'transparent',
      borderRadius: 22,
      borderWidth: 2.5,
      height: 44,
      justifyContent: 'center',
      width: 44,
    },
    ringSelected: {
      borderColor: colors.text,
    },
    swatch: {
      borderRadius: 16,
      height: 32,
      width: 32,
    },
  });
