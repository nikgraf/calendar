import {
  useAccounts,
  useBackendMutations,
  useEventNotificationSettings,
} from '@calendar/app-state';
import {
  describeImportSummary,
  isAppleCalendarAccount,
  isAppleRemindersAccount,
} from '@calendar/core';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type NotificationPermission, notificationPermission } from '../../notifications.ts';
import { Avatar, CapsuleButton, Footer, IconTile, Row, Rows } from '../GroupedList.tsx';
import { accountSubtitle, avatarColors, initialOf } from '../settings/SettingsRoot.tsx';
import { useSettingsConnections } from '../settings/SettingsContext.tsx';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { useSetup } from './SetupContext.tsx';
import { SetupButton, SetupNote, SetupScreen } from './SetupScreen.tsx';

/**
 * After the copy: what the file set is listed as done, and what is this
 * iPhone's own stays to do — a sign-in per Google account (Google opens
 * on the right one each time), the Apple permissions the file says were
 * on, and alerts. Each row is one tap; "Open the calendar" ends the
 * setup with them done or not.
 */
export function SetupCopied() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { finish, imported } = useSetup();
  const { addAccount, busy, calendar, connectDevice, connecting, contacts, error, reminders } =
    useSettingsConnections();
  const accounts = useAccounts();
  const google = accounts.filter((account) => account.provider === 'google');
  const toSignIn = google.filter((account) => account.status === 'reauth_required');
  const calendarPending =
    imported?.appleAccountsPending.some((entry) => entry.kind === 'apple-calendar') === true &&
    !accounts.some(isAppleCalendarAccount);
  const remindersPending =
    imported?.appleAccountsPending.some((entry) => entry.kind === 'apple-reminders') === true &&
    !accounts.some(isAppleRemindersAccount);
  const contactsPending = contacts === 'notDetermined';

  // Alerts: the file's event notifications switch is applied; what iOS
  // still needs is the one-time permission, asked by saving them enabled.
  const { setEventNotificationSettings } = useBackendMutations();
  const notifications = useEventNotificationSettings();
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    let mounted = true;
    void notificationPermission().then((next) => {
      if (mounted) {
        setPermission(next);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);
  const alertsPending = permission === 'undetermined';
  const allowAlerts = async () => {
    setAsking(true);
    try {
      await setEventNotificationSettings({
        enabled: true,
        includeAppleCalendar: notifications?.includeAppleCalendar ?? false,
      });
      setPermission(await notificationPermission());
    } finally {
      setAsking(false);
    }
  };

  const allowRows = [
    calendarPending ? (
      <Row
        accessory={
          <CapsuleButton
            disabled={busy}
            label={connecting === 'calendar' ? 'Asking…' : 'Allow'}
            onPress={() => void connectDevice('calendar')}
            testID="setup-copied-allow-calendar"
          />
        }
        key="calendar"
        leading={<IconTile color={colors['event-blush-edge']} name="calendar" />}
        subtitle={
          calendar === 'notDetermined'
            ? 'Your Mac shows Apple calendars; matched by name here'
            : 'Allow Calendar in Settings › Privacy & Security'
        }
        title="Calendar"
      />
    ) : null,
    remindersPending ? (
      <Row
        accessory={
          <CapsuleButton
            disabled={busy}
            label={connecting === 'reminders' ? 'Asking…' : 'Allow'}
            onPress={() => void connectDevice('reminders')}
            testID="setup-copied-allow-reminders"
          />
        }
        key="reminders"
        leading={<IconTile color={colors['event-blue-edge']} name="checklist" />}
        subtitle={
          reminders === 'notDetermined'
            ? 'Your lists as task lists, as on the Mac'
            : 'Allow Reminders in Settings › Privacy & Security'
        }
        title="Reminders"
      />
    ) : null,
    contactsPending ? (
      <Row
        accessory={
          <CapsuleButton
            disabled={busy}
            label={connecting === 'contacts' ? 'Asking…' : 'Allow'}
            onPress={() => void connectDevice('contacts')}
            testID="setup-copied-allow-contacts"
          />
        }
        key="contacts"
        leading={<IconTile color={colors['border-strong']} name="person.fill" />}
        subtitle="For birthdays and invitees"
        title="Contacts"
      />
    ) : null,
    alertsPending ? (
      <Row
        accessory={
          <CapsuleButton
            disabled={asking}
            label={asking ? 'Asking…' : 'Allow'}
            onPress={() => void allowAlerts()}
            testID="setup-copied-allow-alerts"
          />
        }
        key="alerts"
        leading={<IconTile color={colors['event-mint-edge']} name="bell.fill" />}
        subtitle="Event and birthday reminders, as on the Mac"
        title="Alerts"
      />
    ) : null,
  ].filter((row) => row !== null);

  return (
    <SetupScreen
      actions={
        <SetupButton
          label="Open the calendar"
          onPress={() => finish('done')}
          testID="setup-finish"
        />
      }
      lead="Calendars, zones and alerts are set like on your Mac. What is left is this iPhone’s own: sign in, and allow."
      testID="setup-copied"
      title="Settings copied"
    >
      {google.length > 0 ? (
        <>
          <Text style={styles.header}>
            {toSignIn.length > 0
              ? `Sign in · ${String(google.length - toSignIn.length)} of ${String(google.length)}`
              : 'Signed in'}
          </Text>
          <View style={styles.card}>
            <Rows first>
              {google.map((account, index) => {
                const tint = avatarColors(colors, index);
                const pending = account.status === 'reauth_required';
                return (
                  <Row
                    accessory={
                      pending ? (
                        <CapsuleButton
                          disabled={busy}
                          label={connecting === 'google' ? 'Waiting…' : 'Sign in'}
                          onPress={() => void addAccount({ loginHint: account.email })}
                          testID={`setup-copied-sign-in-${account.id}`}
                        />
                      ) : undefined
                    }
                    key={account.id}
                    leading={
                      <Avatar
                        background={tint.background}
                        foreground={tint.foreground}
                        label={initialOf(account)}
                        uri={account.avatarUrl}
                      />
                    }
                    subtitle={pending ? 'Waits for the sign-in' : accountSubtitle(account)}
                    title={account.email}
                    value={pending ? undefined : 'Signed in'}
                  />
                );
              })}
            </Rows>
          </View>
          {toSignIn.length > 0 ? (
            <SetupNote>
              Google opens on the right account each time — one tap, no choosing.
            </SetupNote>
          ) : null}
        </>
      ) : null}
      {allowRows.length > 0 ? (
        <>
          <Text style={styles.header}>Allow on this iPhone</Text>
          <View style={styles.card}>
            <Rows first>{allowRows}</Rows>
          </View>
        </>
      ) : null}
      {error ? <Footer tone="danger">{error}</Footer> : null}
      {imported ? (
        <>
          <Text style={styles.header}>Already applied</Text>
          <View style={styles.applied}>
            {describeImportSummary(imported).map((line) => (
              <Text key={line} style={styles.appliedLine}>
                {line}
              </Text>
            ))}
          </View>
        </>
      ) : null}
    </SetupScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    applied: {
      gap: 6,
    },
    appliedLine: {
      color: colors['text-secondary'],
      fontSize: 15,
      lineHeight: 20,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      overflow: 'hidden',
    },
    header: {
      color: colors['text-secondary'],
      fontSize: 13,
      marginBottom: -8,
      textTransform: 'uppercase',
    },
  });
