import {
  channel as updatesChannel,
  createdAt as updateCreatedAt,
  fetchUpdateAsync,
  isEmbeddedLaunch,
  isEnabled as updatesEnabled,
  manifest,
  reloadAsync,
  runtimeVersion,
  setUpdateRequestHeadersOverride,
  updateId,
} from 'expo-updates';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import {
  type FetchOutcome,
  loadStep,
  MAIN_CHANNEL,
  overrideFor,
  runningBranch,
} from '../../prPreview.ts';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { ActionRow, Footer, Row, Section, SettingsPage } from '../GroupedList.tsx';

const running = runningBranch(manifest, isEmbeddedLaunch);
// The native constant is '' when the build asks for no channel.
const chosen = updatesChannel || MAIN_CHANNEL;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Internal-testing helper: loads a pull request's OTA update channel
 * (published by CI as `pr-<number>`) into this installed build via the
 * expo-updates request-header override, and switches back to main. Only
 * meaningful in update-enabled (TestFlight) builds — dev clients load from
 * Metro and show a hint instead. Running Now names the branch the running
 * update came from; Channel is the one the build asks for, which Load
 * changes only by restarting into it.
 */
export function PrPreviewPage() {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const [channelInput, setChannelInput] = useState('');
  const [status, setStatus] = useState<{ failed: boolean; text: string } | null>(null);
  const [switching, setSwitching] = useState(false);

  const switchTo = async (target: string) => {
    setSwitching(true);
    setStatus(null);
    try {
      let fetched: FetchOutcome;
      try {
        setUpdateRequestHeadersOverride(overrideFor(target));
        fetched = (await fetchUpdateAsync()).isNew ? 'new' : 'none';
      } catch (error) {
        fetched = { error: errorText(error) };
      }
      const step = loadStep({
        fetched,
        previous: chosen,
        running,
        runtime: runtimeVersion ?? '',
        target,
      });
      if (step.kind === 'reload') {
        await reloadAsync();
        return;
      }
      if (step.kind === 'restore') {
        setUpdateRequestHeadersOverride(overrideFor(chosen));
      }
      setStatus({ failed: step.kind === 'restore', text: step.message });
    } catch (error) {
      setStatus({ failed: true, text: errorText(error) });
    } finally {
      setSwitching(false);
    }
  };

  return (
    <SettingsPage testID="settings-page-pr-preview">
      <Section header="Running Now">
        <Row title="Branch" value={running ?? (isEmbeddedLaunch ? 'Built in' : 'none')} />
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
          <Row title="Channel" value={chosen} />
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
            onPress={() => void switchTo(MAIN_CHANNEL)}
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
