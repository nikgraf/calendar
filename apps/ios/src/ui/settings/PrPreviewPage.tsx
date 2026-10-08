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
import { StyleSheet, TextInput, View } from 'react-native';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { ActionRow, Footer, Row, Section, SettingsPage } from './GroupedList.tsx';

/**
 * Internal-testing helper: loads a pull request's OTA update channel
 * (published by CI as `pr-<number>`) into this installed build via the
 * expo-updates request-header override, and switches back to main. Only
 * meaningful in update-enabled (TestFlight) builds — dev clients load from
 * Metro and show a hint instead.
 */
export function PrPreviewPage() {
  const { colors } = useTheme();
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
    <SettingsPage testID="settings-page-pr-preview">
      <Section header="This Build">
        <Row title="Channel" value={updatesChannel ?? 'none'} />
        <Row title="Update" value={updateId ? updateId.slice(0, 8) : 'embedded'} />
        {updateCreatedAt ? (
          <Row title="Published" value={updateCreatedAt.toLocaleString()} />
        ) : null}
      </Section>
      {updatesEnabled ? (
        <Section
          footer={status ? <Footer>{status}</Footer> : undefined}
          header="Load a Pull Request"
        >
          <View style={styles.field}>
            <TextInput
              accessibilityLabel="Update channel"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!switching}
              onChangeText={setChannelInput}
              placeholder="pr-123"
              placeholderTextColor={colors['text-secondary']}
              style={styles.input}
              value={channelInput}
            />
          </View>
          <ActionRow
            disabled={switching || channelInput.trim() === ''}
            onPress={() => void switchTo(channelInput.trim())}
            title={switching ? 'Switching…' : 'Load PR Channel'}
          />
          <ActionRow
            disabled={switching}
            onPress={() => void switchTo(null)}
            title="Back to Main"
          />
        </Section>
      ) : (
        <Footer>Updates are disabled in this build (a dev client loads from Metro).</Footer>
      )}
    </SettingsPage>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    field: {
      justifyContent: 'center',
      minHeight: 52,
      paddingHorizontal: 16,
    },
    input: {
      color: colors.text,
      fontSize: 17,
    },
  });
