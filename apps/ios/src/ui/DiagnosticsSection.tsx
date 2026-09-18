import { contactsStatusCopy, remindersStatusCopy } from '@calendar/app-state';
import type { ModelStatus } from '@calendar/ai';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { appleLanguageModel } from '../appleModel.ts';
import { appleSpeech } from '../appleSpeech.ts';
import { clearLastRenderError, readLastRenderError } from '../crashLog.ts';
import { iosRemindersClient } from '../remindersClient.ts';
import { sectionStyles } from './settingsShared.ts';

/**
 * What the device actually reports, read from the device. The quick-add
 * bar hid itself on a phone whose owner had Apple Intelligence switched
 * on, and answering "why" meant downloading the shipped IPA and reading
 * its linked frameworks — this is the cheaper version of that.
 */
const IOS_SETTINGS_PATH = 'Settings › Privacy & Security';

export function DiagnosticsSection({
  contacts,
  reminders,
  visible,
}: {
  contacts: string;
  reminders: string;
  visible: boolean;
}) {
  const [modelStatus, setModelStatus] = useState<ModelStatus | 'checking…'>('checking…');
  const [dictation, setDictation] = useState('checking…');
  const [reminderListCount, setReminderListCount] = useState<number | undefined>();
  const [lastError, setLastError] = useState(readLastRenderError);

  useEffect(() => {
    if (!visible) {
      return;
    }
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
  }, [visible]);

  useEffect(() => {
    if (!visible || reminders !== 'fullAccess') {
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
  }, [reminders, visible]);

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
        {reminders === 'fullAccess' && reminderListCount !== undefined
          ? ` (${String(reminderListCount)} lists)`
          : ''}
      </Text>
      <Text style={sectionStyles.meta} testID="diagnostics-contacts">
        contacts: {contactsStatusCopy(contacts, IOS_SETTINGS_PATH)}
      </Text>
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
