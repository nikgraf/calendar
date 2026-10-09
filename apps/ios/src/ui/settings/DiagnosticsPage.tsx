import {
  appleCalendarStatusCopy,
  contactsStatusCopy,
  remindersStatusCopy,
} from '@calendar/app-state';
import type { ModelStatus } from '@calendar/ai';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { appleLanguageModel } from '../../appleModel.ts';
import { appleSpeech } from '../../appleSpeech.ts';
import { clearLastRenderError, readLastRenderError } from '../../crashLog.ts';
import { iosRemindersClient } from '../../remindersClient.ts';
import { ActionRow, Footer, Row, Section, SettingsPage } from './GroupedList.tsx';
import { IOS_SETTINGS_PATH, useSettingsConnections } from './SettingsContext.tsx';

/**
 * What the device actually reports, read from the device. The quick-add
 * bar hid itself on a phone whose owner had Apple Intelligence switched
 * on, and answering "why" meant downloading the shipped IPA and reading
 * its linked frameworks — this is the cheaper version of that.
 */
export function DiagnosticsPage() {
  const { calendar, contacts, reminders } = useSettingsConnections();
  const [modelStatus, setModelStatus] = useState<ModelStatus | 'checking…'>('checking…');
  const [dictation, setDictation] = useState('checking…');
  const [reminderListCount, setReminderListCount] = useState<number | undefined>();
  const [lastError, setLastError] = useState(readLastRenderError);

  useEffect(() => {
    let cancelled = false;
    void appleLanguageModel.status().then((value) => {
      if (!cancelled) {
        setModelStatus(value);
      }
    });
    void appleSpeech
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
        <Row title="On-Device Model" value={modelStatus} valueTestID="diagnostics-model" />
        <Row title="Dictation" value={dictation} />
        {/* Hermes ships without it; a "missing" here explains any failure
            to save an event, since ids are generated from it. */}
        <Row
          title="Web Crypto"
          value={typeof globalThis.crypto?.getRandomValues === 'function' ? 'ok' : 'missing'}
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
