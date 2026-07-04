import { useAccounts, useBackendMutations, useCalendars, usePendingOps } from '@calendar/app-state';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { palette } from './theme.ts';

export function SettingsSheet({ onClose, visible }: { onClose: () => void; visible: boolean }) {
  const mutations = useBackendMutations();
  const accounts = useAccounts();
  const calendars = useCalendars();
  const pendingOps = usePendingOps();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addAccount = async () => {
    setBusy(true);
    setError(null);
    try {
      await mutations.addAccount(undefined);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <View style={styles.container}>
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
                    {op.kind} · {op.title ?? op.eventId}
                    {op.attempts > 0 ? ` — retrying (${op.attempts}×)` : ''}
                  </Text>
                  <Pressable onPress={() => void mutations.discardPendingOp({ opId: op.id })}>
                    <Text style={styles.pendingDiscard}>Discard</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}

          {accounts.map((account) => (
            <View key={account.id} style={styles.accountCard}>
              <View style={styles.accountHeader}>
                <View style={styles.accountInfo}>
                  <Text style={styles.accountName}>{account.displayName ?? account.email}</Text>
                  <Text style={styles.accountEmail}>
                    {account.email}
                    {account.status === 'reauth_required' ? ' — sign in again' : ''}
                  </Text>
                </View>
                <Pressable onPress={() => void mutations.removeAccount({ accountId: account.id })}>
                  <Text style={styles.remove}>Remove</Text>
                </Pressable>
              </View>
              {calendars
                .filter((calendar) => calendar.accountId === account.id)
                .map((calendar) => (
                  <Pressable
                    key={calendar.id}
                    onPress={() =>
                      void mutations.setCalendarVisible({
                        accountId: calendar.accountId,
                        calendarId: calendar.id,
                        isVisible: !calendar.isVisible,
                      })
                    }
                    style={styles.calendarRow}
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
                    <Text
                      style={[styles.calendarName, !calendar.isVisible && styles.calendarHidden]}
                    >
                      {calendar.summary}
                    </Text>
                  </Pressable>
                ))}
            </View>
          ))}

          <Pressable
            disabled={busy}
            onPress={() => void addAccount()}
            style={[styles.addButton, busy && styles.addBusy]}
          >
            <Text style={styles.addLabel}>
              {busy ? 'Waiting for Google…' : 'Add Google Account'}
            </Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  accountCard: {
    backgroundColor: '#ffffff',
    borderColor: palette.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
    padding: 12,
  },
  accountEmail: {
    color: palette.textMuted,
    fontSize: 13,
  },
  accountHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  accountInfo: {
    flex: 1,
  },
  accountName: {
    fontSize: 15,
    fontWeight: '600',
  },
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
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
});
