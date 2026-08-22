import { useAccounts, useBackendMutations, useCalendars, usePendingOps } from '@calendar/app-state';
import { CALENDAR_PALETTE } from '@calendar/core';
import {
  channel as updatesChannel,
  createdAt as updateCreatedAt,
  fetchUpdateAsync,
  isEnabled as updatesEnabled,
  reloadAsync,
  setUpdateRequestHeadersOverride,
  updateId,
} from 'expo-updates';
import { useState } from 'react';
import {
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { palette } from './theme.ts';

export function SettingsSheet({ onClose, visible }: { onClose: () => void; visible: boolean }) {
  const mutations = useBackendMutations();
  const accounts = useAccounts();
  const calendars = useCalendars();
  const pendingOps = usePendingOps();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** `${accountId}:${calendarId}` of the row with the palette expanded. */
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);

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
                    {op.kind === 'calendarColor' ? 'color' : op.kind} ·{' '}
                    {op.kind === 'calendarColor' ? op.calendarId : (op.title ?? op.eventId)}
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
                  <Text style={styles.accountEmail}>{account.email}</Text>
                  {account.status === 'reauth_required' ? (
                    <Pressable disabled={busy} onPress={() => void addAccount()}>
                      <Text style={styles.reconnect}>Session expired — reconnect</Text>
                    </Pressable>
                  ) : null}
                </View>
                <Pressable onPress={() => void mutations.removeAccount({ accountId: account.id })}>
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
                                backgroundColor: calendar.isVisible
                                  ? calendar.colorHex
                                  : 'transparent',
                                borderColor: calendar.colorHex,
                              },
                            ]}
                          />
                        </Pressable>
                        <Pressable
                          onPress={() =>
                            void mutations.setCalendarVisible({
                              accountId: calendar.accountId,
                              calendarId: calendar.id,
                              isVisible: !calendar.isVisible,
                            })
                          }
                          style={styles.calendarToggle}
                        >
                          <Text
                            style={[
                              styles.calendarName,
                              !calendar.isVisible && styles.calendarHidden,
                            ]}
                          >
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
                                void mutations.setCalendarColor({
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

          <PrPreviewSection />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/**
 * Internal-testing helper: loads a pull request's OTA update channel
 * (published by CI as `pr-<number>`) into this installed build via the
 * expo-updates request-header override, and switches back to main. Only
 * meaningful in update-enabled (TestFlight) builds — dev clients load from
 * Metro and show a hint instead.
 */
function PrPreviewSection() {
  const [channelInput, setChannelInput] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const switchTo = async (channel: string | null) => {
    setSwitching(true);
    setStatus(null);
    try {
      setUpdateRequestHeadersOverride(channel ? { 'expo-channel-name': channel } : null);
      const result = await fetchUpdateAsync();
      if (result.isNew) {
        await reloadAsync();
        return;
      }
      setStatus(
        channel
          ? `Override set for ${channel}. No update fetched yet — force-quit and reopen the app.`
          : 'Back on the main channel. Force-quit and reopen to be sure.',
      );
    } catch (error) {
      setStatus(String(error));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <View style={styles.previewCard}>
      <Text style={styles.previewTitle}>PR preview</Text>
      <Text style={styles.previewMeta}>
        channel {updatesChannel ?? 'none'} · update {updateId ? updateId.slice(0, 8) : 'embedded'}
        {updateCreatedAt ? ` · ${updateCreatedAt.toLocaleString()}` : ''}
      </Text>
      {updatesEnabled ? (
        <>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            editable={!switching}
            onChangeText={setChannelInput}
            placeholder="pr-123"
            style={styles.previewInput}
            value={channelInput}
          />
          <View style={styles.previewButtons}>
            <Pressable
              disabled={switching || channelInput.trim() === ''}
              onPress={() => void switchTo(channelInput.trim())}
              style={[styles.previewLoad, switching && styles.addBusy]}
            >
              <Text style={styles.previewLoadLabel}>
                {switching ? 'Switching…' : 'Load PR channel'}
              </Text>
            </Pressable>
            <Pressable disabled={switching} onPress={() => void switchTo(null)}>
              <Text style={styles.previewReset}>Back to main</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <Text style={styles.previewMeta}>
          Updates are disabled in this build (dev client loads from Metro).
        </Text>
      )}
      {status ? <Text style={styles.previewStatus}>{status}</Text> : null}
    </View>
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
  calendarToggle: {
    flex: 1,
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
  previewButtons: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    marginTop: 8,
  },
  previewCard: {
    backgroundColor: '#ffffff',
    borderColor: palette.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 16,
    padding: 12,
  },
  previewInput: {
    borderColor: palette.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 14,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  previewLoad: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  previewLoadLabel: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  previewMeta: {
    color: palette.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  previewReset: {
    color: '#2563eb',
    fontSize: 14,
    fontWeight: '600',
  },
  previewStatus: {
    color: palette.textMuted,
    fontSize: 12,
    marginTop: 8,
  },
  previewTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  reconnect: {
    color: '#d97706',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
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
