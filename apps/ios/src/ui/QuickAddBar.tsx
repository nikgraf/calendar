import { parseQuickAdd, type LanguageModel, type SpeechToText } from '@calendar/ai';
import { Temporal } from '@calendar/core';
import type { EventEditorPrefill } from '@calendar/app-state';
import { useEffect, useState } from 'react';
import {
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { palette } from './theme.ts';

/**
 * Natural-language capture: a phrase becomes a prefilled editor the user
 * confirms — nothing is written by the model. Hidden entirely when no
 * on-device model exists, leaving the manual `＋` flow untouched.
 */
/**
 * Linear PCM in a .wav container, not the m4a preset: the transcription
 * API writes the bytes to an extension-less temp file and opens it with
 * AVAudioFile, so the container has to be recognisable from its header.
 */
const WAV_RECORDING = {
  android: { audioEncoder: 'default', outputFormat: 'default' },
  bitRate: 256_000,
  extension: '.wav',
  ios: {
    audioQuality: 96,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
    outputFormat: IOSOutputFormat.LINEARPCM,
  },
  numberOfChannels: 1,
  sampleRate: 16_000,
  web: {},
} as const;

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
  const recorder = useAudioRecorder(WAV_RECORDING);

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
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        // A refusal is a choice, not a failure: typing still works.
        setError('Microphone access is off — you can still type.');
        return;
      }
      setVoice('preparing');
      try {
        // First run installs the locale's models; later runs return at once.
        // Failure here means this device cannot transcribe at all.
        await speech.prepare();
      } catch {
        setVoiceAvailable(false);
        setVoice('idle');
        setError('Dictation is unavailable on this device.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setVoice('recording');
    } catch {
      setVoice('idle');
      setError('Could not start recording.');
    }
  };

  const stopRecording = async () => {
    setVoice('transcribing');
    try {
      await recorder.stop();
      const uri = recorder.uri;
      const text = uri ? await speech.transcribeFile(uri) : undefined;
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
            disabled={phrase.trim() === ''}
            onPress={() => void submit()}
            style={[styles.button, phrase.trim() === '' && styles.buttonDisabled]}
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
