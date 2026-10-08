import {
  useAccounts,
  useBackendMutations,
  useGuardedMutations,
  useCalendars,
  usePendingOps,
  useSyncStatus,
  useTaskLists,
  useTimeZones,
  pendingOpLabel,
  appleCalendarStatusCopy,
  contactsStatusCopy,
  remindersStatusCopy,
} from '@calendar/app-state';
import {
  isAppleCalendarAccount,
  isAppleRemindersAccount,
  isParkedOp,
  isSignInCancelled,
} from '@calendar/core';
import { Effect } from 'effect';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { iosAppleCalendarClient } from '../appleCalendarClient.ts';
import { iosContactsClient } from '../contactsClient.ts';
import { iosRemindersClient } from '../remindersClient.ts';
import { AccountCard } from './AccountCard.tsx';
import { BirthdayRemindersSection } from './BirthdayRemindersSection.tsx';
import { askConflict } from './conflictAlert.ts';
import { EventNotificationsSection } from './EventNotificationsSection.tsx';
import { DiagnosticsSection } from './DiagnosticsSection.tsx';
import { LocationsSection } from './LocationsSection.tsx';
import { MirrorsSection } from './MirrorsSection.tsx';
import { PrPreviewSection } from './PrPreviewSection.tsx';
import { SettingsFileSection } from './SettingsFileSection.tsx';
import { TimeZonesSection } from './TimeZonesSection.tsx';
import { type ThemeColors, useStyles } from './theme.ts';
import { MutationNoticeToast } from './Toast.tsx';

const IOS_SETTINGS_PATH = 'Settings › Privacy & Security';
/**
 * Re-reads of a permission status after a prompt was answered (~10 s in
 * all): iOS records the answer a moment after the alert closes, and a CI
 * runner has shown several seconds of "notDetermined" after "Allow".
 */
const STATUS_SETTLE_TRIES = 40;
const STATUS_SETTLE_MS = 200;
type Connection = 'calendar' | 'contacts' | 'google' | 'reminders';

/**
 * The settings screen, presented as a modal route (`app/settings.tsx`)
 * from the calendar's gear: accounts, connections and the sections.
 * Mounted only while open, so what used to key on `visible` runs on mount.
 */
export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const styles = useStyles(makeStyles);
  const mutations = useBackendMutations();
  const guarded = useGuardedMutations();
  const accounts = useAccounts();
  const calendars = useCalendars();
  const pendingOps = usePendingOps();
  const syncStatus = useSyncStatus();
  const taskLists = useTaskLists();
  const { primary: timeZone } = useTimeZones();
  const [connecting, setConnecting] = useState<Connection | null>(null);
  const busyRef = useRef(false);
  const busy = connecting !== null;
  const [error, setError] = useState<string | null>(null);
  const [contacts, setContacts] = useState('checking…');
  const [contactsConnectionFailed, setContactsConnectionFailed] = useState(false);
  const [reminders, setReminders] = useState('checking…');
  const [calendar, setCalendar] = useState('checking…');
  const refreshVersion = useRef(0);
  const contactsConnected = contacts === 'authorized' || contacts === 'limited';
  const hasRemindersAccount = accounts.some(isAppleRemindersAccount);
  const hasCalendarAccount = accounts.some(isAppleCalendarAccount);

  const refreshPermissions = useCallback(async () => {
    const version = ++refreshVersion.current;
    const [contactsStatus, remindersStatus, calendarStatus] = await Promise.all([
      Effect.runPromise(
        iosContactsClient.status().pipe(Effect.orElseSucceed(() => 'Could not check access.')),
      ),
      Effect.runPromise(
        iosRemindersClient.status().pipe(Effect.orElseSucceed(() => 'Could not check access.')),
      ),
      Effect.runPromise(
        iosAppleCalendarClient.status().pipe(Effect.orElseSucceed(() => 'Could not check access.')),
      ),
    ]);
    if (version === refreshVersion.current) {
      setContacts(contactsStatus);
      setReminders(remindersStatus);
      setCalendar(calendarStatus);
    }
    return { calendar: calendarStatus, contacts: contactsStatus, reminders: remindersStatus };
  }, []);

  useEffect(() => {
    void refreshPermissions();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshPermissions();
      }
    });
    return () => {
      refreshVersion.current += 1;
      subscription.remove();
    };
  }, [refreshPermissions]);

  const connectDevice = async (provider: 'calendar' | 'contacts' | 'reminders') => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setConnecting(provider);
    setError(null);
    let granted: boolean | undefined;
    const name =
      provider === 'contacts'
        ? 'Contacts'
        : provider === 'calendar'
          ? 'Apple Calendar'
          : 'Apple Reminders';
    try {
      const connect =
        provider === 'contacts'
          ? mutations.connectContacts
          : provider === 'calendar'
            ? mutations.connectAppleCalendar
            : mutations.connectReminders;
      granted = (await connect(undefined)).granted;
      if (provider === 'contacts') {
        setContactsConnectionFailed(!granted);
      }
    } catch (error) {
      if (provider === 'contacts') {
        setContactsConnectionFailed(true);
      }
      setError(
        `Could not connect ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      let statuses = await refreshPermissions();
      // iOS records the answer shortly after the prompt closes: a read right
      // after "Allow" or "Don't Allow" can still say notDetermined, which
      // left the connect row up after a grant and reported "the prompt did
      // not open" after a refusal. Give it a moment before trusting it.
      for (
        let attempt = 0;
        granted !== undefined &&
        statuses[provider] === 'notDetermined' &&
        attempt < STATUS_SETTLE_TRIES;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, STATUS_SETTLE_MS));
        statuses = await refreshPermissions();
      }
      if (granted === false) {
        const status = statuses[provider];
        if (status === 'notDetermined') {
          setError(`The ${name} permission prompt did not open. Try again.`);
        } else if (status === 'authorized' || status === 'limited' || status === 'fullAccess') {
          setError(`${name} access is allowed, but the connection did not finish. Try again.`);
        } else if (!['denied', 'restricted', 'unavailable', 'writeOnly'].includes(status)) {
          setError(`${name}: ${status} Try again.`);
        }
      }
      busyRef.current = false;
      setConnecting(null);
    }
  };

  const openSettings = async () => {
    try {
      await Linking.openSettings();
    } catch (error) {
      setError(
        `Could not open Settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /** `loginHint`: the account being reconnected — Google opens on it. */
  const addAccount = async (loginHint?: string) => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setConnecting('google');
    setError(null);
    try {
      await mutations.addAccount(loginHint === undefined ? {} : { loginHint });
    } catch (error) {
      // A dismissed sheet is the user changing their mind, not an error.
      if (!isSignInCancelled(error)) {
        setError(String(error));
      }
    } finally {
      busyRef.current = false;
      setConnecting(null);
    }
  };

  return (
    <>
      <SafeAreaView style={styles.container} testID="settings-screen">
        <View style={styles.header}>
          <Text style={styles.title}>Accounts</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

        {/* keyboardShouldPersistTaps: the responder system follows the React
            tree, so a Modal rendered by a section (the time-zone picker)
            still bubbles through this ScrollView, which would otherwise eat
            the first tap on a row to dismiss the picker's keyboard. */}
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {error ? <Text style={styles.error}>{error}</Text> : null}

          {pendingOps.length > 0 ? (
            <View style={styles.pendingCard}>
              <Text style={styles.pendingTitle}>
                {pendingOps.length} unsynced {pendingOps.length === 1 ? 'change' : 'changes'}
              </Text>
              {pendingOps.map((op) => (
                <View key={op.id} style={styles.pendingRow}>
                  <Text numberOfLines={1} style={styles.pendingLabel}>
                    {pendingOpLabel(op).text}
                    {pendingOpLabel(op).retry ? ` — ${pendingOpLabel(op).retry}` : ''}
                  </Text>
                  {isParkedOp(op) ? (
                    <Pressable onPress={() => askConflict(op, guarded.resolveConflict, timeZone)}>
                      <Text style={styles.pendingResolve}>Resolve</Text>
                    </Pressable>
                  ) : (
                    <Pressable onPress={() => void guarded.discardPendingOp({ opId: op.id })}>
                      <Text style={styles.pendingDiscard}>Discard</Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </View>
          ) : null}

          {accounts.map((account) => (
            <AccountCard
              account={account}
              busy={busy}
              calendars={calendars}
              key={account.id}
              onReconnect={() => void addAccount(account.email)}
              syncStatus={syncStatus.find((entry) => entry.accountId === account.id)}
              taskLists={taskLists}
            />
          ))}

          <Pressable
            disabled={busy}
            onPress={() => void addAccount()}
            style={[styles.addButton, busy && styles.addBusy]}
          >
            <Text style={styles.addLabel}>
              {connecting === 'google' ? 'Waiting for Google…' : 'Add Google Account'}
            </Text>
          </Pressable>
          {!hasCalendarAccount || calendar === 'notDetermined' || calendar === 'writeOnly' ? (
            <Pressable
              disabled={busy}
              onPress={() => void connectDevice('calendar')}
              style={[styles.addButton, styles.addSecondary, busy && styles.addBusy]}
              testID="connect-apple-calendar"
            >
              <Text style={styles.addLabel}>
                {connecting === 'calendar'
                  ? 'Connecting Calendar…'
                  : `${hasCalendarAccount ? 'Reconnect' : 'Connect'} Apple Calendar`}
              </Text>
            </Pressable>
          ) : null}
          {['denied', 'restricted', 'unavailable', 'writeOnly'].includes(calendar) ? (
            <Text style={styles.connectionStatus}>
              Calendar: {appleCalendarStatusCopy(calendar, IOS_SETTINGS_PATH)}
            </Text>
          ) : null}
          {!hasRemindersAccount || reminders === 'notDetermined' || reminders === 'writeOnly' ? (
            <Pressable
              disabled={busy}
              onPress={() => void connectDevice('reminders')}
              style={[styles.addButton, styles.addSecondary, busy && styles.addBusy]}
              testID="connect-reminders"
            >
              <Text style={styles.addLabel}>
                {connecting === 'reminders'
                  ? 'Connecting Reminders…'
                  : `${hasRemindersAccount ? 'Reconnect' : 'Connect'} Apple Reminders`}
              </Text>
            </Pressable>
          ) : null}
          {['denied', 'restricted', 'unavailable', 'writeOnly'].includes(reminders) ? (
            <Text style={styles.connectionStatus}>
              Reminders: {remindersStatusCopy(reminders, IOS_SETTINGS_PATH)}
            </Text>
          ) : null}
          {contactsConnected && !contactsConnectionFailed ? (
            <Text style={styles.connectionStatus} testID="contacts-connected">
              {contacts === 'limited'
                ? 'Contacts access allowed — selected contacts only'
                : 'Contacts access allowed'}
            </Text>
          ) : (
            <Pressable
              disabled={busy}
              onPress={() => void connectDevice('contacts')}
              style={[styles.addButton, styles.addSecondary, busy && styles.addBusy]}
              testID="connect-contacts"
            >
              <Text style={styles.addLabel}>
                {connecting === 'contacts' ? 'Connecting Contacts…' : 'Connect Contacts'}
              </Text>
            </Pressable>
          )}
          {['denied', 'restricted', 'unavailable'].includes(contacts) ? (
            <Text style={styles.connectionStatus}>
              Contacts: {contactsStatusCopy(contacts, IOS_SETTINGS_PATH)}
            </Text>
          ) : null}
          {contacts === 'denied' ||
          reminders === 'denied' ||
          reminders === 'writeOnly' ||
          calendar === 'denied' ||
          calendar === 'writeOnly' ? (
            <Pressable
              disabled={busy}
              onPress={() => void openSettings()}
              testID="open-device-settings"
            >
              <Text style={styles.settingsLink}>Open Settings</Text>
            </Pressable>
          ) : null}

          <EventNotificationsSection />
          <BirthdayRemindersSection />
          <TimeZonesSection />
          <MirrorsSection />
          <SettingsFileSection />
          <LocationsSection />
          <PrPreviewSection />
          <DiagnosticsSection contacts={contacts} reminders={reminders} visible />
        </ScrollView>
        {/* RN Modals cover the root screen's toast, so this sheet mounts
            its own listener for failures triggered from inside it. */}
        <MutationNoticeToast />
      </SafeAreaView>
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    addBusy: {
      opacity: 0.5,
    },
    addButton: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingVertical: 12,
    },
    addLabel: {
      color: colors['on-primary'],
      fontSize: 15,
      fontWeight: '600',
    },
    addSecondary: {
      backgroundColor: colors.text,
      marginTop: 8,
    },
    connectionStatus: {
      color: colors['text-secondary'],
      fontSize: 13,
      marginTop: 10,
    },
    container: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    content: {
      padding: 16,
    },
    done: {
      color: colors.primary,
      fontSize: 16,
      fontWeight: '600',
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      marginBottom: 10,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    pendingCard: {
      backgroundColor: colors.warning,
      borderRadius: 10,
      marginBottom: 14,
      padding: 12,
    },
    pendingDiscard: {
      color: colors.danger,
      fontSize: 13,
      fontWeight: '600',
    },
    pendingLabel: {
      color: colors['text-secondary'],
      flex: 1,
      fontSize: 13,
    },
    pendingResolve: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: '600',
    },
    pendingRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      paddingVertical: 3,
    },
    pendingTitle: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '700',
      marginBottom: 4,
    },
    settingsLink: {
      color: colors.primary,
      fontSize: 14,
      fontWeight: '600',
      marginTop: 10,
      paddingVertical: 4,
    },
    title: {
      fontSize: 17,
      fontWeight: '700',
    },
  });
