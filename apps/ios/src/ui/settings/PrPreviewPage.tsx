import {
  channel as updatesChannel,
  createdAt as updateCreatedAt,
  fetchUpdateAsync,
  isEmbeddedLaunch,
  isEmergencyLaunch,
  isEnabled as updatesEnabled,
  manifest,
  reloadAsync,
  runtimeVersion,
  setUpdateRequestHeadersOverride,
  updateId,
} from 'expo-updates';
import { useState, useSyncExternalStore } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { createPreviewStore, MAIN_CHANNEL, runningBranch } from '../../prPreview.ts';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { ActionRow, Footer, Row, Section, SettingsPage } from '../GroupedList.tsx';

const running = runningBranch(manifest, isEmbeddedLaunch);

// Seeded with the launch's channel: the native constant is '' when the
// build asks for none.
const preview = createPreviewStore(
  {
    fetchUpdate: fetchUpdateAsync,
    reload: reloadAsync,
    setOverride: setUpdateRequestHeadersOverride,
  },
  { running, runtime: runtimeVersion ?? '', saved: updatesChannel || MAIN_CHANNEL },
);

/**
 * Internal-testing helper: loads a pull request's OTA update channel
 * (published by CI as `pr-<number>`) into this installed build via the
 * expo-updates request-header override, and switches back to main. Only
 * meaningful in TestFlight builds: a dev client loads from Metro and
 * refuses the override, which the page reports. Running Now names the
 * branch the running update came from; Channel is the one the build asks
 * for.
 */
export function PrPreviewPage() {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const [channelInput, setChannelInput] = useState('');
  const { saved, status, switching } = useSyncExternalStore(preview.subscribe, preview.getState);

  return (
    <SettingsPage testID="settings-page-pr-preview">
      <Section header="Running Now">
        <Row
          title="Branch"
          value={running ?? (isEmbeddedLaunch || isEmergencyLaunch ? 'Built in' : 'none')}
        />
        <Row title="Update" value={updateId ? updateId.slice(0, 8) : 'embedded'} />
        {updateCreatedAt ? (
          <Row title="Published" value={updateCreatedAt.toLocaleString()} />
        ) : null}
      </Section>
      {updatesEnabled ? (
        <Section
          footer={
            status ? (
              <Footer selectable tone={status.failed ? 'danger' : 'secondary'}>
                {status.text}
              </Footer>
            ) : undefined
          }
          header="Load a Pull Request"
        >
          <Row title="Channel" value={saved} />
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
            onPress={() => void preview.switchTo(channelInput.trim())}
            title={switching ? 'Switching…' : 'Load PR Channel'}
          />
          <ActionRow
            disabled={switching}
            onPress={() => void preview.switchTo(MAIN_CHANNEL)}
            title="Back to Main"
          />
        </Section>
      ) : (
        <Footer>Updates are disabled in this build.</Footer>
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
