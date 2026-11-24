import {
  FLOW_DOWNLOADS,
  FLOW_MODELS,
  type FlowModelStatus,
  flowPromise,
  PARAKEET_BYTES,
  PUBLISHED_MODEL,
  phrasesModelStatus,
  speechModelStatus,
} from '@calendar/ai';
import { StyleSheet, View } from 'react-native';
import { assistantDownload, useAssistantModelState } from '../../assistantRuntime.ts';
import { parakeet, useParakeetState } from '../../parakeetRuntime.ts';
import { AssistantFlow } from '../assistant/AssistantFlow.tsx';
import {
  ActionRow,
  IconTile,
  NavRow,
  PageHero,
  Row,
  Rows,
  RowSlot,
  Section,
  SettingsPage,
} from '../GroupedList.tsx';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';

/** A model's download as it runs: the row's thin bar. */
function Progress({ percent, testID }: { percent: number; testID: string }) {
  const styles = useStyles(makeStyles);
  return (
    <RowSlot>
      <View
        accessibilityLabel={`${String(percent)} percent downloaded`}
        accessibilityRole="progressbar"
        style={styles.track}
        testID={testID}
      >
        <View style={[styles.fill, { width: `${String(percent)}%` }]} />
      </View>
    </RowSlot>
  );
}

/** One model: its name and what it does, where it stands, and the one action it offers. */
function ModelRows({
  model,
  onAction,
  status,
}: {
  model: 'phrases' | 'speech';
  onAction: (kind: 'download' | 'mobile' | 'retry') => void;
  status: FlowModelStatus;
}) {
  const info = FLOW_MODELS[model];
  // `Rows`: the card sees this as one child, so the rows learn their place from it.
  return (
    <Rows>
      <Row
        subtitle={`${info.does}${info.optional ? ' · optional' : ''}\n${status.line}`}
        subtitleTestID={`assistant-model-${model}-status`}
        testID={`assistant-model-${model}`}
        title={info.name}
      />
      {status.progress === undefined ? null : (
        <Progress percent={status.progress} testID={`assistant-model-${model}-progress`} />
      )}
      {status.action === undefined ? null : (
        <ActionRow
          onPress={() => {
            if (status.action !== undefined) {
              onAction(status.action.kind);
            }
          }}
          testID={`assistant-model-${model}-action`}
          title={status.action.label}
        />
      )}
    </Rows>
  );
}

/**
 * Settings › Assistant: that the Assistant uses only models on this
 * iPhone, how a phrase becomes an event (`AssistantFlow`), and the two
 * models — where each stands and its one action (download, mobile data,
 * try again). The speech model's switch and Delete stay in Dictation.
 */
export function AssistantPage() {
  const { colors } = useTheme();
  const assistant = useAssistantModelState();
  const download = assistantDownload();
  const size = download.size() ?? PUBLISHED_MODEL.bytes;
  const speechState = useParakeetState();
  const phrases = phrasesModelStatus(assistant, {
    device: 'iPhone',
    network: download.network(),
    size,
  });
  const speech =
    speechState.files.kind === 'unsupported'
      ? undefined
      : speechModelStatus(speechState, { device: 'iPhone', network: parakeet().network() });
  return (
    <SettingsPage testID="settings-page-assistant">
      <PageHero
        icon={<IconTile color={colors['event-lilac-edge']} name="lock.shield.fill" size={56} />}
        subtitle={flowPromise('iPhone')}
        title="AI on This iPhone Only"
      />
      <Section header="How It Works">
        <RowSlot testID="assistant-flow-card">
          <AssistantFlow sizes={{ phrases: size, speech: PARAKEET_BYTES }} />
        </RowSlot>
      </Section>
      <Section
        footer={
          speech === undefined
            ? FLOW_DOWNLOADS
            : `${FLOW_DOWNLOADS} The speech model’s switch and Delete are in Dictation.`
        }
        header="Models"
      >
        <ModelRows
          model="phrases"
          onAction={(kind) => {
            if (kind === 'download') {
              void download.agree('wifi');
            } else if (kind === 'mobile') {
              void download.allowMobileData();
            } else {
              void download.retry();
            }
          }}
          status={phrases}
        />
        {speech === undefined ? null : (
          <ModelRows
            model="speech"
            onAction={(kind) => {
              const store = parakeet();
              if (kind === 'download') {
                void store.download('wifi');
              } else if (kind === 'mobile') {
                void store.allowMobileData();
              } else {
                void store.retry();
              }
            }}
            status={speech}
          />
        )}
        {speech === undefined ? null : (
          <NavRow
            href="/settings/dictation"
            testID="assistant-speech-dictation"
            title="Read With Parakeet"
            value={speechState.on ? 'On' : 'Off'}
          />
        )}
      </Section>
    </SettingsPage>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fill: {
      backgroundColor: colors.primary,
      borderRadius: 2,
      height: 4,
    },
    track: {
      backgroundColor: colors.fill,
      borderRadius: 2,
      height: 4,
      overflow: 'hidden',
    },
  });
