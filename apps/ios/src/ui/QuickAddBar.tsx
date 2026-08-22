import {
  MicrophoneDeniedError,
  parseQuickAdd,
  SpeechUnsupportedError,
  type LanguageModel,
  type SpeechToText,
} from '@calendar/ai';
import { Temporal } from '@calendar/core';
import type { EventEditorPrefill } from '@calendar/app-state';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { palette } from './theme.ts';

/**
 * Natural-language capture: a phrase becomes a prefilled editor the user
 * confirms — nothing is written by the model. Hidden entirely when no
 * on-device model exists, leaving the manual `＋` flow untouched.
 */
/** A forgotten recording stops itself rather than running until the app dies. */
const MAX_RECORDING_MS = 60_000;

type VoiceState = 'idle' | 'preparing' | 'recording' | 'transcribing';

export function QuickAddBar({
  focusedDate,
  model,
  onParsed,
  speech,
  timeZone,
}: {
  focusedDate: Temporal.PlainDate;
  model: LanguageModel;
  onParsed: (prefill: EventEditorPrefill) => void;
  speech: SpeechToText;
  timeZone: string;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void model.isAvailable().then((value) => {
      if (!cancelled) {
        setAvailable(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [model]);

  useEffect(() => {
    let cancelled = false;
    void speech.isSupported().then((value) => {
      if (!cancelled) {
        setVoiceAvailable(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [speech]);

  const submit = async (text: string = phrase) => {
    if (!text.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await parseQuickAdd(model, {
        // Undated phrases land on the day being viewed; relative ones still
        // resolve against today.
        fallbackDate: focusedDate.toString(),
        phrase: text,
        referenceDate: Temporal.Now.plainDateISO(timeZone).toString(),
        timeZone,
      });
      if (result.kind === 'rejected') {
        setError(result.reason);
        return;
      }
      setPhrase('');
      onParsed(result.prefill);
    } catch {
      setError('On-device model unavailable.');
    } finally {
      setBusy(false);
    }
  };

  const startRecording = async () => {
    setError(null);
    setVoice('preparing');
    try {
      // Prepare first: asking for the microphone before knowing dictation
      // can run would extract a permanent permission for nothing.
      await speech.prepare();
    } catch (error) {
      setVoice('idle');
      if (error instanceof SpeechUnsupportedError) {
        setVoiceAvailable(false);
        setError('Dictation is unavailable on this device.');
      } else {
        // Installing the locale's models needs the network, so a failure
        // here is often transient — keep the mic and let them retry.
        setError("Couldn't set up dictation — try again.");
      }
      return;
    }
    try {
      await speech.startRecording();
      setVoice('recording');
    } catch (error) {
      setVoice('idle');
      setError(
        error instanceof MicrophoneDeniedError
          ? 'Microphone access is off — you can still type.'
          : 'Could not start recording.',
      );
    }
  };

  const stopRecording = async () => {
    setVoice('transcribing');
    try {
      const text = await speech.stopRecording();
      if (!text) {
        setError("Didn't catch that — try again.");
        return;
      }
      setPhrase(text);
      await submit(text);
    } catch {
      setError('Could not transcribe that.');
    } finally {
      setVoice('idle');
    }
  };

  // Stop a forgotten recording, and never leave one running when the bar
  // goes away (switching to Month view unmounts it).
  useEffect(() => {
    if (voice !== 'recording') {
      return;
    }
    const timer = setTimeout(() => void stopRecording(), MAX_RECORDING_MS);
    return () => {
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart the cap per recording
  }, [voice]);

  useEffect(
    () => () => {
      void speech.cancelRecording();
    },
    [speech],
  );

  if (available !== true) {
    // The marker still renders so e2e can distinguish "checked, no model"
    // from "not checked yet" instead of racing the mount.
    return available === false ? <View testID="quick-add-state" /> : null;
  }

  return (
    <View style={styles.container} testID="quick-add-state">
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Describe an event to add"
          editable={!busy}
          onChangeText={setPhrase}
          onSubmitEditing={() => void submit()}
          placeholder="Lunch with Sarah tomorrow at 1"
          returnKeyType="go"
          style={styles.input}
          testID="quick-add-input"
          value={phrase}
        />
        {voiceAvailable && !busy && voice !== 'transcribing' ? (
          <Pressable
            accessibilityLabel={voice === 'recording' ? 'Stop dictating' : 'Dictate an event'}
            accessibilityRole="button"
            disabled={voice === 'preparing'}
            onPress={() => void (voice === 'recording' ? stopRecording() : startRecording())}
            style={[styles.mic, voice === 'recording' && styles.micRecording]}
            testID="quick-add-mic"
          >
            <Text style={styles.micLabel}>{voice === 'recording' ? '■' : '🎙'}</Text>
          </Pressable>
        ) : null}
        {busy || voice === 'transcribing' || voice === 'preparing' ? (
          <ActivityIndicator style={styles.spinner} />
        ) : (
          <Pressable
            accessibilityLabel="Add the described event"
            accessibilityRole="button"
            disabled={phrase.trim() === '' || voice === 'recording'}
            onPress={() => void submit()}
            style={[
              styles.button,
              (phrase.trim() === '' || voice === 'recording') && styles.buttonDisabled,
            ]}
            testID="quick-add-submit"
          >
            <Text style={styles.buttonLabel}>Add</Text>
          </Pressable>
        )}
      </View>
      {voice === 'preparing' ? (
        <Text style={styles.hint}>Preparing dictation…</Text>
      ) : voice === 'recording' ? (
        <Text style={styles.hint}>Listening — tap ■ when finished.</Text>
      ) : voice === 'transcribing' ? (
        <Text style={styles.hint}>Transcribing…</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonLabel: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  container: {
    borderBottomColor: palette.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 8,
    paddingHorizontal: 12,
  },
  error: {
    color: '#b91c1c',
    fontSize: 12,
    marginTop: 6,
  },
  hint: {
    color: palette.textMuted,
    fontSize: 12,
    marginTop: 6,
  },
  input: {
    borderColor: palette.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  mic: {
    borderColor: palette.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  micLabel: {
    fontSize: 15,
  },
  micRecording: {
    backgroundColor: '#fee2e2',
    borderColor: '#dc2626',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  spinner: {
    paddingHorizontal: 18,
  },
});
