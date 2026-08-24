import {
  MicrophoneDeniedError,
  parseQuickAdd,
  SpeechUnsupportedError,
  type LanguageModel,
  type ModelStatus,
  type SpeechToText,
} from '@calendar/ai';
import { Temporal, type FreeSlot } from '@calendar/core';
import type { EventEditorPrefill } from '@calendar/app-state';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { palette } from './theme.ts';

/** Foundation Models exist from iOS 26; below that there is nothing to say. */
const MODEL_MIN_IOS = 26;

/** `Platform.Version` is a string like "26.0" on iOS, a number elsewhere. */
const iosMajorVersion = (): number => Number.parseInt(String(Platform.Version), 10);

const UNAVAILABLE_NOTICE =
  'Quick add needs Apple Intelligence. Switch it on in Settings → Apple Intelligence & Siri; ' +
  'its models can take a while to download after that.';

const slotLabel = (slot: FreeSlot): string => {
  const day = Temporal.PlainDate.from(slot.date).toLocaleString('en-US', {
    day: 'numeric',
    weekday: 'short',
  });
  return `${day} · ${slot.startTime}–${slot.endTime}`;
};

/** A forgotten recording stops itself rather than running until the app dies. */
const MAX_RECORDING_MS = 60_000;

type VoiceState = 'idle' | 'preparing' | 'recording' | 'transcribing';

/**
 * Natural-language capture, typed or dictated: a phrase becomes a
 * prefilled editor the user confirms — nothing is written by the model.
 *
 * With no model the bar used to vanish without a word, which is how a
 * phone with Apple Intelligence switched on still showed nothing and left
 * no way to tell why. It now explains itself wherever the user could
 * plausibly act, and hides only where they could not.
 */
export interface FoundSlots {
  readonly slots: ReadonlyArray<FreeSlot>;
  readonly title?: string | undefined;
}

export function QuickAddBar({
  findSlots,
  focusedDate,
  model,
  onParsed,
  speech,
  timeZone,
}: {
  /**
   * The find-a-time pipeline (parse → fetch events → solve), owned by the
   * app so the bar stays platform-dumb. Resolves to a rejection reason
   * string instead of slots when the phrase couldn't be read.
   */
  findSlots: (phrase: string) => Promise<FoundSlots | { readonly reason: string }>;
  focusedDate: Temporal.PlainDate;
  model: LanguageModel;
  onParsed: (prefill: EventEditorPrefill) => void;
  speech: SpeechToText;
  timeZone: string;
}) {
  const [mode, setMode] = useState<'add' | 'find'>('add');
  const [found, setFound] = useState<FoundSlots | null>(null);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      setChecking(true);
      void model
        .status()
        .then((value) => {
          if (!cancelled) {
            setStatus(value);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setChecking(false);
          }
        });
    };
    check();
    // Apple Intelligence is switched on in Settings, which means leaving
    // the app: re-check on the way back so the bar appears without a
    // relaunch. Model downloads finish out of process too.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        check();
      }
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [attempt, model]);

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
    setFound(null);
    try {
      if (mode === 'find') {
        const result = await findSlots(text);
        if ('reason' in result) {
          setError(result.reason);
          return;
        }
        if (result.slots.length === 0) {
          setError('No free slots match — widen the window?');
          return;
        }
        setFound(result);
        return;
      }
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

  const pickSlot = (slot: FreeSlot) => {
    setFound(null);
    setPhrase('');
    onParsed({
      date: slot.date,
      endTime: slot.endTime,
      isAllDay: false,
      startTime: slot.startTime,
      title: found?.title ?? '',
    });
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

  if (status === null) {
    // Nothing decided yet — rendering a marker now would let e2e read a
    // pending check as a settled answer.
    return null;
  }

  if (status !== 'ready') {
    // A build without the framework, or an OS too old for it, gives the
    // user nothing to act on, so stay out of the way. Otherwise say why
    // the bar is empty: the silence is what made this hard to diagnose.
    // Dictation stays hidden either way — a transcript still needs the
    // model to become an event.
    if (status === 'missing-module' || iosMajorVersion() < MODEL_MIN_IOS) {
      // The marker still renders so e2e can distinguish "checked, no
      // model" from "not checked yet" instead of racing the mount.
      return <View testID="quick-add-state" />;
    }
    return (
      <View style={styles.container} testID="quick-add-state">
        <View style={styles.row}>
          <Text style={styles.notice}>{UNAVAILABLE_NOTICE}</Text>
          <Pressable
            accessibilityLabel="Check for the on-device model again"
            accessibilityRole="button"
            disabled={checking}
            onPress={() => setAttempt((value) => value + 1)}
            style={[styles.button, checking && styles.buttonDisabled]}
            testID="quick-add-recheck"
          >
            <Text style={styles.buttonLabel}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="quick-add-state">
      <View style={styles.row}>
        <Pressable
          accessibilityLabel={
            mode === 'find' ? 'Switch back to quick add' : 'Switch to finding a free time'
          }
          accessibilityRole="button"
          onPress={() => {
            setMode(mode === 'find' ? 'add' : 'find');
            setError(null);
            setFound(null);
          }}
          style={[styles.mic, mode === 'find' && styles.modeActive]}
          testID="find-time-mode"
        >
          <Text style={styles.micLabel}>⏱</Text>
        </Pressable>
        <TextInput
          accessibilityLabel={
            mode === 'find' ? 'Describe the time you need' : 'Describe an event to add'
          }
          editable={!busy}
          onChangeText={setPhrase}
          onSubmitEditing={() => void submit()}
          placeholder={
            mode === 'find' ? '90 min focus this week, mornings' : 'Lunch with Sarah tomorrow at 1'
          }
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
            <Text style={styles.buttonLabel}>{mode === 'find' ? 'Find' : 'Add'}</Text>
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
      {found ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.slotRow}>
          {found.slots.map((slot, index) => (
            <Pressable
              key={`${slot.date}T${slot.startTime}`}
              onPress={() => pickSlot(slot)}
              style={styles.slotChip}
              testID={`find-time-slot-${index}`}
            >
              <Text style={styles.slotLabel}>{slotLabel(slot)}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
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
  modeActive: {
    backgroundColor: '#dbeafe',
    borderColor: '#2563eb',
  },
  notice: {
    color: palette.textMuted,
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  slotChip: {
    backgroundColor: '#eff6ff',
    borderColor: '#bfdbfe',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  slotLabel: {
    color: '#1d4ed8',
    fontSize: 13,
  },
  slotRow: {
    marginTop: 8,
  },
  spinner: {
    paddingHorizontal: 18,
  },
});
