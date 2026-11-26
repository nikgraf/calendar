import {
  appleCalendarStatusCopy,
  contactsStatusCopy,
  remindersStatusCopy,
  useAction,
  useModelAvailability,
} from '@calendar/app-state';
import { noticeCopy, sessionCountLabel, sessionExportName, sessionLogCopy } from '@calendar/ai';
import { Effect } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Alert, Platform, Share } from 'react-native';
import { assistantSessions } from '../../assistantSessions.ts';
import { appleLanguageModel } from '../../appleModel.ts';
import { speech } from '../../speech.ts';
import { assistantDownload, useAssistantModelState } from '../../assistantRuntime.ts';
import {
  clearLastDictationError,
  clearLastRenderError,
  readLastDictationError,
  readLastRenderError,
} from '../../crashLog.ts';
import { readLaunchTimes } from '../../launchTiming.ts';
import { launchLine, launchTitle, launchTotal } from '../../launchTimes.ts';
import {
  availabilityDetails,
  availabilityGuidance,
  checkResultLine,
} from '../../modelAvailabilityCopy.ts';
import { iosRemindersClient } from '../../remindersClient.ts';
import { onAppActive } from '../../appActive.ts';
import { ActionRow, Footer, Row, Section, SettingsPage, SwitchRow } from '../GroupedList.tsx';
import { IOS_SETTINGS_PATH, useSettingsConnections } from './SettingsContext.tsx';

/** Delete All asks first: nothing brings the sessions back. */
const confirmDelete = () => {
  Alert.alert(
    'Delete All Assistant Sessions?',
    'The sessions kept on this iPhone go. A file you exported stays where you saved it.',
    [
      { style: 'cancel', text: 'Cancel' },
      { onPress: assistantSessions.delete, style: 'destructive', text: 'Delete All' },
    ],
  );
};

/**
 * What the device actually reports, read from the device. The quick-add
 * bar hid itself on a phone whose owner had Apple Intelligence switched
 * on, and answering "why" meant downloading the shipped IPA and reading
 * its linked frameworks — this is the cheaper version of that.
 */
export function DiagnosticsPage() {
  const { calendar, contacts, reminders } = useSettingsConnections();
  // The device's own model, not `languageModel`: under the e2e bundle's
  // fixture model quick add always reads "ready", and this page is where
  // the real answer must still show. Same checks and words as the notice.
  const { availability, checkedAt, lastManualCheck, manualChecking, retry, status } =
    useModelAvailability(appleLanguageModel, onAppActive);
  const assistant = useAssistantModelState();
  const download = assistantDownload();
  const assistantCopy = noticeCopy(assistant, {
    device: 'iPhone',
    network: download.network(),
    size: download.size(),
  });
  const [dictation, setDictation] = useState('checking…');
  const [reminderListCount, setReminderListCount] = useState<number | undefined>();
  const [lastError, setLastError] = useState(readLastRenderError);
  const [dictationError, setDictationError] = useState(readLastDictationError);
  const [launches] = useState(readLaunchTimes);
  const sessions = useSyncExternalStore(assistantSessions.subscribe, assistantSessions.get);
  const exporting = useAction();
  const exportSessions = () =>
    void exporting.run(async () => {
      const file = assistantSessions.file();
      if (file) {
        await Share.share({
          title: sessionExportName(new Date().toISOString().slice(0, 10)),
          url: file.uri,
        });
      }
    });

  // Every answer to Check Again is read out, the same one twice included.
  useEffect(() => {
    if (lastManualCheck) {
      AccessibilityInfo.announceForAccessibility(checkResultLine(lastManualCheck));
    }
  }, [lastManualCheck]);

  useEffect(() => {
    let cancelled = false;
    void speech
      .isSupported()
      .then((value) => {
        if (!cancelled) {
          setDictation(value ? 'supported' : 'unsupported');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDictation('unsupported');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (reminders !== 'fullAccess') {
      return;
    }
    let cancelled = false;
    void Effect.runPromise(
      iosRemindersClient.listLists().pipe(
        Effect.map((lists) => lists.length),
        Effect.orElseSucceed(() => undefined),
      ),
    ).then((count) => {
      if (!cancelled) {
        setReminderListCount(count);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reminders]);

  return (
    <SettingsPage testID="settings-page-diagnostics">
      <Section header="This iPhone">
        <Row title="iOS" value={String(Platform.Version)} />
        <Row title="Dictation" value={dictation} />
        {/* Hermes ships without it; a "missing" here explains any failure
            to save an event, since ids are generated from it. */}
        <Row
          title="Web Crypto"
          value={typeof globalThis.crypto?.getRandomValues === 'function' ? 'ok' : 'missing'}
        />
      </Section>
      <Section header="Assistant Model">
        <Row
          subtitle={assistantCopy.lines.join(' ') || undefined}
          title="Download"
          value={
            assistant.kind === 'unsupported' ? `unsupported (${assistant.reason})` : assistant.kind
          }
          valueTestID="diagnostics-assistant-model"
        />
        {assistantCopy.action ? (
          <ActionRow
            onPress={() => {
              const kind = assistantCopy.action?.kind;
              if (kind === 'download') {
                void download.agree('wifi');
              } else if (kind === 'mobile') {
                void download.allowMobileData();
              } else {
                void download.retry();
              }
            }}
            testID="diagnostics-assistant-model-action"
            title={assistantCopy.action.label}
          />
        ) : null}
      </Section>
      <Section
        footer={
          <Footer testID="assistant-sessions-copy">
            {exporting.error ?? sessionLogCopy('iPhone')}
          </Footer>
        }
        header="Assistant Sessions"
        testID="assistant-sessions"
      >
        <SwitchRow
          onValueChange={assistantSessions.setOn}
          switchTestID="keep-assistant-sessions"
          title="Keep Assistant Sessions"
          value={sessions.on}
        />
        <Row
          title="Kept"
          value={sessionCountLabel(sessions.count).replace(' kept', '')}
          valueTestID="assistant-sessions-count"
        />
        <ActionRow
          disabled={sessions.count === 0 || exporting.busy}
          onPress={exportSessions}
          testID="assistant-sessions-export"
          title="Export…"
        />
        <ActionRow
          disabled={sessions.count === 0}
          onPress={confirmDelete}
          testID="assistant-sessions-delete"
          title="Delete All…"
          tone="destructive"
        />
      </Section>
      <Section
        footer={
          availability ? (
            <Footer selectable testID="diagnostics-model-details">
              {availabilityDetails(availability, checkedAt)}
            </Footer>
          ) : undefined
        }
        header="On-Device Model"
      >
        <Row
          subtitle={availability ? availabilityGuidance(availability) : undefined}
          subtitleTestID="diagnostics-model-guidance"
          title="Apple Intelligence"
          value={status ?? 'checking…'}
          valueTestID="diagnostics-model"
        />
        <ActionRow
          disabled={manualChecking}
          onPress={retry}
          subtitle={lastManualCheck ? checkResultLine(lastManualCheck) : undefined}
          subtitleTestID="diagnostics-model-check-result"
          testID="diagnostics-model-recheck"
          title={manualChecking ? 'Checking…' : 'Check Again'}
        />
      </Section>
      <Section
        footer="What this iPhone reports right now — the first place to look when a feature such as quick add or dictation does not show up."
        header="Access"
      >
        <Row
          subtitle={appleCalendarStatusCopy(calendar, IOS_SETTINGS_PATH)}
          testID="diagnostics-calendar"
          title="Calendar"
        />
        <Row
          subtitle={`${remindersStatusCopy(reminders, IOS_SETTINGS_PATH)}${
            reminders === 'fullAccess' && reminderListCount !== undefined
              ? ` (${String(reminderListCount)} lists)`
              : ''
          }`}
          subtitleTestID="diagnostics-reminders"
          title="Reminders"
        />
        <Row
          subtitle={contactsStatusCopy(contacts, IOS_SETTINGS_PATH)}
          subtitleTestID="diagnostics-contacts"
          title="Contacts"
        />
      </Section>
      {launches.length > 0 ? (
        <Section
          footer="How long the last launches took, counted from the moment the app started: until its JavaScript ran, until the first frame, until the calendar was drawn. A launch closed while it waited ends at the step it never reached."
          header="Launches"
        >
          {launches.map((record, index) => (
            <Row
              key={record.start}
              subtitle={launchLine(record)}
              subtitleTestID={index === 0 ? 'diagnostics-launch-steps' : undefined}
              title={launchTitle(record)}
              value={launchTotal(record)}
            />
          ))}
        </Section>
      ) : null}
      {dictationError ? (
        <Section
          footer={
            <Footer selectable testID="diagnostics-dictation-error">
              {`${dictationError.at}: ${dictationError.detail}`}
            </Footer>
          }
          header="Last Dictation Error"
        >
          <ActionRow
            onPress={() => {
              clearLastDictationError();
              setDictationError(null);
            }}
            title="Clear"
          />
        </Section>
      ) : null}
      {lastError ? (
        <Section
          footer={
            <Footer selectable testID="diagnostics-last-error">
              {`${lastError.at}: ${lastError.detail}`}
            </Footer>
          }
          header="Last Render Error"
        >
          <ActionRow
            onPress={() => {
              clearLastRenderError();
              setLastError(null);
            }}
            title="Clear"
          />
        </Section>
      ) : null}
    </SettingsPage>
  );
}
