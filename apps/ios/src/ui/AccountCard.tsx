import { useGuardedMutations } from '@calendar/app-state';
import {
  type Account,
  CALENDAR_PALETTE,
  type CalendarInfo,
  type TaskListInfo,
} from '@calendar/core';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { sectionStyles } from './settingsShared.ts';
import { palette } from './theme.ts';

/** One account in Settings: header, calendar toggles + palette, task lists. */
export function AccountCard({
  account,
  busy,
  calendars,
  onReconnect,
  taskLists,
}: {
  account: Account;
  /** A sign-in is in flight; reconnect actions are disabled meanwhile. */
  busy: boolean;
  calendars: ReadonlyArray<CalendarInfo>;
  /** Re-runs Google sign-in: re-auth, or consenting to the tasks scope. */
  onReconnect: () => void;
  taskLists: ReadonlyArray<TaskListInfo>;
}) {
  const guarded = useGuardedMutations();
  /** `${accountId}:${calendarId}` of the row with the palette expanded. */
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.info}>
          <Text style={styles.name}>{account.displayName ?? account.email}</Text>
          {account.provider === 'apple' ? (
            <Text style={styles.email}>This device</Text>
          ) : (
            <Text style={styles.email}>{account.email}</Text>
          )}
          {account.status === 'reauth_required' ? (
            account.provider === 'apple' ? (
              <Text style={sectionStyles.action}>
                Reminders access is off — allow it in Settings › Privacy & Security › Reminders; it
                reconnects on its own.
              </Text>
            ) : (
              <Pressable disabled={busy} onPress={onReconnect}>
                <Text style={sectionStyles.action}>Session expired — reconnect</Text>
              </Pressable>
            )
          ) : null}
        </View>
        <Pressable onPress={() => void guarded.removeAccount({ accountId: account.id })}>
          <Text style={styles.remove}>Remove</Text>
        </Pressable>
      </View>
      {calendars
        .filter((calendar) => calendar.accountId === account.id)
        .map((calendar) => {
          const rowKey = `${calendar.accountId}:${calendar.id}`;
          return (
            <View key={calendar.id}>
              <View style={styles.calendarRow}>
                <Pressable
                  onPress={() =>
                    setColorPickerFor((current) => (current === rowKey ? null : rowKey))
                  }
                  testID={`calendar-color-${calendar.id}`}
                >
                  <View
                    style={[
                      styles.swatch,
                      {
                        backgroundColor: calendar.isVisible ? calendar.colorHex : 'transparent',
                        borderColor: calendar.colorHex,
                      },
                    ]}
                  />
                </Pressable>
                <Pressable
                  onPress={() =>
                    void guarded.setCalendarVisible({
                      accountId: calendar.accountId,
                      calendarId: calendar.id,
                      isVisible: !calendar.isVisible,
                    })
                  }
                  style={styles.calendarToggle}
                >
                  <Text style={[styles.calendarName, !calendar.isVisible && styles.calendarHidden]}>
                    {calendar.summary}
                  </Text>
                </Pressable>
              </View>
              {colorPickerFor === rowKey ? (
                <View style={styles.paletteRow}>
                  {CALENDAR_PALETTE.map((hex) => (
                    <Pressable
                      key={hex}
                      onPress={() => {
                        setColorPickerFor(null);
                        void guarded.setCalendarColor({
                          accountId: calendar.accountId,
                          calendarId: calendar.id,
                          colorHex: hex,
                        });
                      }}
                    >
                      <View
                        style={[
                          styles.paletteSwatch,
                          { backgroundColor: hex },
                          hex === calendar.colorHex && styles.paletteSelected,
                        ]}
                      />
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      {taskLists
        .filter((list) => list.accountId === account.id)
        .map((list) => (
          <Pressable
            key={list.id}
            onPress={() =>
              void guarded.setTaskListVisible({
                accountId: list.accountId,
                isVisible: !list.isVisible,
                taskListId: list.id,
              })
            }
            style={styles.calendarToggle}
            testID={`task-list-${list.id}`}
          >
            <Text style={[styles.calendarName, !list.isVisible && styles.calendarHidden]}>
              ✓ {list.title}
            </Text>
            {list.colorHex ? (
              <View style={[styles.swatch, { backgroundColor: list.colorHex }]} />
            ) : null}
          </Pressable>
        ))}
      {account.tasksEnabled || account.provider !== 'google' ? null : (
        // Tokens from before the tasks scope: re-running sign-in
        // re-consents and upgrades the account in place.
        <Pressable disabled={busy} onPress={onReconnect}>
          <Text style={sectionStyles.action}>Connect Google Tasks — sign in again</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  calendarHidden: {
    color: palette.textFaint,
  },
  calendarName: {
    fontSize: 14,
  },
  calendarRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 5,
  },
  calendarToggle: {
    flex: 1,
  },
  card: {
    backgroundColor: '#ffffff',
    borderColor: palette.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
    padding: 12,
  },
  email: {
    color: palette.textMuted,
    fontSize: 13,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  info: {
    flex: 1,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
  },
  paletteRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingBottom: 8,
    paddingLeft: 22,
  },
  paletteSelected: {
    borderColor: '#2563eb',
    borderWidth: 2,
  },
  paletteSwatch: {
    borderColor: 'transparent',
    borderRadius: 5,
    borderWidth: 2,
    height: 20,
    width: 20,
  },
  remove: {
    color: '#dc2626',
    fontSize: 13,
  },
  swatch: {
    borderRadius: 4,
    borderWidth: 2,
    height: 16,
    width: 16,
  },
});
