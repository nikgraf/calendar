import { contactsStatusCopy, remindersStatusCopy, useBackendMutations } from '@calendar/app-state';
import type { ModelStatus } from '@calendar/ai';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { appleLanguageModel } from '../appleModel.ts';
import { appleSpeech } from '../appleSpeech.ts';
import { iosContactsClient } from '../contactsClient.ts';
import { clearLastRenderError, readLastRenderError } from '../crashLog.ts';
import { iosRemindersClient } from '../remindersClient.ts';
import { sectionStyles } from './settingsShared.ts';

/**
 * What the device actually reports, read from the device. The quick-add
 * bar hid itself on a phone whose owner had Apple Intelligence switched
 * on, and answering "why" meant downloading the shipped IPA and reading
 * its linked frameworks — this is the cheaper version of that.
 */
const describeReminders = async (): Promise<string> => {
  const status = await Effect.runPromise(
    iosRemindersClient.status().pipe(Effect.orElseSucceed(() => 'unavailable' as const)),
  );
  if (status !== 'fullAccess') {
    return status;
  }
  const lists = await Effect.runPromise(
    iosRemindersClient.listLists().pipe(Effect.orElseSucceed(() => [])),
  );
  return `fullAccess (${String(lists.length)} lists)`;
};

const describeContacts = (): Promise<string> =>
  Effect.runPromise(
    iosContactsClient.status().pipe(Effect.orElseSucceed(() => 'unavailable' as const)),
  );

const IOS_SETTINGS_PATH = 'Settings › Privacy & Security';

export function DiagnosticsSection() {
  const [modelStatus, setModelStatus] = useState<ModelStatus | 'checking…'>('checking…');
  const [contacts, setContacts] = useState('checking…');
  const [dictation, setDictation] = useState('checking…');
  const [reminders, setReminders] = useState('checking…');
  const [remindersBusy, setRemindersBusy] = useState(false);
  const [lastError, setLastError] = useState(readLastRenderError);
  const mutations = useBackendMutations();

  const requestReminders = async () => {
    setRemindersBusy(true);
    try {
      // The rpc, not the bare permission ask: a grant alone creates no
      // account and syncs nothing.
      const result = await mutations.connectReminders(undefined);
      setReminders(result.granted ? await describeReminders() : 'denied');
    } catch {
      setReminders(await describeReminders());
    } finally {
      setRemindersBusy(false);
    }
  };

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
    void describeReminders().then((text) => {
      if (!cancelled) {
        setReminders(text);
      }
    });
    void describeContacts().then((text) => {
      if (!cancelled) {
        setContacts(text);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={sectionStyles.card} testID="diagnostics">
      <Text style={sectionStyles.title}>Diagnostics</Text>
      <Text style={sectionStyles.meta}>iOS {String(Platform.Version)}</Text>
      <Text style={sectionStyles.meta} testID="diagnostics-model">
        on-device model: {modelStatus}
      </Text>
      <Text style={sectionStyles.meta}>dictation: {dictation}</Text>
      <Text style={sectionStyles.meta} testID="diagnostics-reminders">
        reminders: {remindersStatusCopy(reminders, IOS_SETTINGS_PATH)}
      </Text>
      {reminders === 'notDetermined' || reminders === 'denied' ? (
        <Pressable disabled={remindersBusy} onPress={() => void requestReminders()}>
          <Text style={sectionStyles.action}>
            {reminders === 'denied'
              ? 'Reminders access is off — check again after allowing it in Settings'
              : 'Allow access to Reminders'}
          </Text>
        </Pressable>
      ) : null}
      <Text style={sectionStyles.meta} testID="diagnostics-contacts">
        contacts: {contactsStatusCopy(contacts, IOS_SETTINGS_PATH)}
      </Text>
      {contacts === 'notDetermined' || contacts === 'denied' ? (
        <Pressable
          onPress={() =>
            void mutations
              .connectContacts(undefined)
              .then(describeContacts, describeContacts)
              .then(setContacts)
          }
        >
          <Text style={sectionStyles.action}>
            {contacts === 'denied'
              ? 'Contacts access is off — check again after allowing it in Settings'
              : 'Allow access to Contacts'}
          </Text>
        </Pressable>
      ) : null}
      <Text style={sectionStyles.meta}>
        {/* Hermes ships without it; a "missing" here explains any failure
            to save an event, since ids are generated from it. */}
        web crypto: {typeof globalThis.crypto?.getRandomValues === 'function' ? 'ok' : 'missing'}
      </Text>
      {lastError ? (
        <>
          <Text
            numberOfLines={6}
            selectable
            style={sectionStyles.meta}
            testID="diagnostics-last-error"
          >
            last render error ({lastError.at}): {lastError.detail}
          </Text>
          <Pressable
            onPress={() => {
              clearLastRenderError();
              setLastError(null);
            }}
          >
            <Text style={sectionStyles.action}>Clear</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
