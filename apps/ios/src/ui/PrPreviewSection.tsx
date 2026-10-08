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
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSectionStyles } from './settingsShared.ts';
import { type ThemeColors, useStyles } from './theme.ts';

/**
 * Internal-testing helper: loads a pull request's OTA update channel
 * (published by CI as `pr-<number>`) into this installed build via the
 * expo-updates request-header override, and switches back to main. Only
 * meaningful in update-enabled (TestFlight) builds — dev clients load from
 * Metro and show a hint instead.
 */
export function PrPreviewSection() {
  const sectionStyles = useSectionStyles();
  const styles = useStyles(makeStyles);
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
    <View style={sectionStyles.card}>
      <Text style={sectionStyles.title}>PR preview</Text>
      <Text style={sectionStyles.meta}>
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
            style={styles.input}
            value={channelInput}
          />
          <View style={styles.buttons}>
            <Pressable
              disabled={switching || channelInput.trim() === ''}
              onPress={() => void switchTo(channelInput.trim())}
              style={[styles.load, switching && sectionStyles.busy]}
            >
              <Text style={styles.loadLabel}>{switching ? 'Switching…' : 'Load PR channel'}</Text>
            </Pressable>
            <Pressable disabled={switching} onPress={() => void switchTo(null)}>
              <Text style={styles.reset}>Back to main</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <Text style={sectionStyles.meta}>
          Updates are disabled in this build (dev client loads from Metro).
        </Text>
      )}
      {status ? <Text style={styles.status}>{status}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    buttons: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 14,
      marginTop: 8,
    },
    input: {
      borderColor: colors.border,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      fontSize: 14,
      marginTop: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    load: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    loadLabel: {
      color: colors['on-primary'],
      fontSize: 14,
      fontWeight: '600',
    },
    reset: {
      color: colors.primary,
      fontSize: 14,
      fontWeight: '600',
    },
    status: {
      color: colors['text-secondary'],
      fontSize: 12,
      marginTop: 8,
    },
  });
