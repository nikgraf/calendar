import {
  useAccounts,
  useBackendMutations,
  useGuardedMutations,
  useCalendars,
  usePendingOps,
  useSyncStatus,
  useTaskLists,
  pendingOpLabel,
  contactsStatusCopy,
  remindersStatusCopy,
} from '@calendar/app-state';
import { Effect } from 'effect';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { iosContactsClient } from '../contactsClient.ts';
import { iosRemindersClient } from '../remindersClient.ts';
import { AccountCard } from './AccountCard.tsx';
import { BirthdayRemindersSection } from './BirthdayRemindersSection.tsx';
import { DiagnosticsSection } from './DiagnosticsSection.tsx';
import { PrPreviewSection } from './PrPreviewSection.tsx';
import { palette } from './theme.ts';
import { MutationNoticeToast } from './Toast.tsx';

const IOS_SETTINGS_PATH = 'Settings › Privacy & Security';
type Connection = 'contacts' | 'google' | 'reminders';

export function SettingsSheet({ onClose, visible }: { onClose: () => void; visible: boolean }) {
  const mutations = useBackendMutations();
  const guarded = useGuardedMutations();
  const accounts = useAccounts();
  const calendars = useCalendars();
  const pendingOps = usePendingOps();
  const syncStatus = useSyncStatus();
  const taskLists = useTaskLists();
  const [connecting, setConnecting] = useState<Connection | null>(null);
  const busyRef = useRef(false);
  const busy = connecting !== null;
  const [error, setError] = useState<string | null>(null);
  const [contacts, setContacts] = useState('checking…');
  const [contactsConnectionFailed, setContactsConnectionFailed] = useState(false);
  const [reminders, setReminders] = useState('checking…');
  const refreshVersion = useRef(0);
  const contactsConnected = contacts === 'authorized' || contacts === 'limited';
  const hasRemindersAccount = accounts.some((account) => account.provider === 'apple');

  const refreshPermissions = useCallback(async () => {
    const version = ++refreshVersion.current;
    const [contactsStatus, remindersStatus] = await Promise.all([
      Effect.runPromise(
        iosContactsClient.status().pipe(Effect.orElseSucceed(() => 'Could not check access.')),
      ),
      Effect.runPromise(
        iosRemindersClient.status().pipe(Effect.orElseSucceed(() => 'Could not check access.')),
      ),
    ]);
    if (version === refreshVersion.current) {
      setContacts(contactsStatus);
      setReminders(remindersStatus);
    }
    return { contacts: contactsStatus, reminders: remindersStatus };
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }
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
  }, [refreshPermissions, visible]);

  const connectDevice = async (provider: 'contacts' | 'reminders') => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setConnecting(provider);
    setError(null);
    let granted: boolean | undefined;
    const name = provider === 'contacts' ? 'Contacts' : 'Apple Reminders';
    try {
      const connect =
        provider === 'contacts' ? mutations.connectContacts : mutations.connectReminders;
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
      const statuses = await refreshPermissions();
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

  const addAccount = async () => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setConnecting('google');
    setError(null);
    try {
      await mutations.addAccount(undefined);
    } catch (error) {
      setError(String(error));
    } finally {
      busyRef.current = false;
      setConnecting(null);
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      visible={visible}
    >
      {/* overFullScreen draws under the status bar; inset it ourselves. */}
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Accounts</Text>
          <Pressable onPress={onClose}>
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
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
                  <Pressable onPress={() => void guarded.discardPendingOp({ opId: op.id })}>
                    <Text style={styles.pendingDiscard}>Discard</Text>
                  </Pressable>
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
              onReconnect={() => void addAccount()}
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
          {contacts === 'denied' || reminders === 'denied' || reminders === 'writeOnly' ? (
            <Pressable
              disabled={busy}
              onPress={() => void openSettings()}
              testID="open-device-settings"
            >
              <Text style={styles.settingsLink}>Open Settings</Text>
            </Pressable>
          ) : null}

          <BirthdayRemindersSection />
          <PrPreviewSection />
          <DiagnosticsSection contacts={contacts} reminders={reminders} visible={visible} />
        </ScrollView>
        {/* RN Modals cover the root screen's toast, so this sheet mounts
            its own listener for failures triggered from inside it. */}
        <MutationNoticeToast />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  addBusy: {
    opacity: 0.5,
  },
  addButton: {
    alignItems: 'center',
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingVertical: 12,
  },
  addLabel: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  addSecondary: {
    backgroundColor: '#171717',
    marginTop: 8,
  },
  connectionStatus: {
    color: palette.textMuted,
    fontSize: 13,
    marginTop: 10,
  },
  container: {
    backgroundColor: palette.background,
    flex: 1,
  },
  content: {
    padding: 16,
  },
  done: {
    color: '#2563eb',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: '#b91c1c',
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
    backgroundColor: '#fef3c7',
    borderRadius: 10,
    marginBottom: 14,
    padding: 12,
  },
  pendingDiscard: {
    color: '#dc2626',
    fontSize: 13,
    fontWeight: '600',
  },
  pendingLabel: {
    color: '#92400e',
    flex: 1,
    fontSize: 13,
  },
  pendingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 3,
  },
  pendingTitle: {
    color: '#92400e',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  settingsLink: {
    color: '#2563eb',
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
