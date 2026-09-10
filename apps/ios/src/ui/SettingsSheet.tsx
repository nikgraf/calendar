import {
  useAccounts,
  useBackendMutations,
  useGuardedMutations,
  useCalendars,
  usePendingOps,
  useTaskLists,
  pendingOpLabel,
} from '@calendar/app-state';
import { Effect } from 'effect';
import { useState } from 'react';
import { Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AccountCard } from './AccountCard.tsx';
import { DiagnosticsSection } from './DiagnosticsSection.tsx';
import { PrPreviewSection } from './PrPreviewSection.tsx';
import { palette } from './theme.ts';
import { MutationNoticeToast } from './Toast.tsx';

export function SettingsSheet({ onClose, visible }: { onClose: () => void; visible: boolean }) {
  const mutations = useBackendMutations();
  const guarded = useGuardedMutations();
  const accounts = useAccounts();
  const calendars = useCalendars();
  const pendingOps = usePendingOps();
  const taskLists = useTaskLists();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectReminders = async () => {
    setError(null);
    const result = await Effect.runPromise(
      Effect.tryPromise(() => mutations.connectReminders(undefined)).pipe(
        Effect.orElseSucceed(() => ({ granted: false })),
      ),
    );
    if (!result.granted) {
      setError(
        'Reminders access was not granted. Allow it in Settings › Privacy & Security › Reminders, then try again.',
      );
    }
  };

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
              taskLists={taskLists}
            />
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
          {accounts.some((account) => account.provider === 'apple') ? null : (
            <Pressable
              onPress={() => void connectReminders()}
              style={[styles.addButton, styles.addSecondary]}
              testID="connect-reminders"
            >
              <Text style={styles.addLabel}>Connect Apple Reminders</Text>
            </Pressable>
          )}

          <PrPreviewSection />
          <DiagnosticsSection />
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
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
});
