import {
  MicrophoneDeniedError,
  parseQuickAdd,
  SpeechUnsupportedError,
  type LanguageModel,
  type SpeechToText,
} from '@calendar/ai';
import { Temporal } from '@calendar/core';
import { useEffect, useRef, useState } from 'react';
import type { QuickAddItem } from './quickAddItem.ts';

/** A forgotten recording stops itself rather than running until the app dies. */
const MAX_RECORDING_MS = 60_000;

export type VoiceState = 'idle' | 'preparing' | 'recording' | 'transcribing';

export interface QuickAddModelOptions {
  /** Undated phrases land on this day (the day being viewed, or the editor's). */
  readonly fallbackDate?: string | undefined;
  readonly model: LanguageModel;
  /**
   * Receives what the phrase was understood as: the editor below the
   * field fills its form from it. The phrase stays in the field, so what
   * was read can be compared with what the form shows.
   */
  readonly onApply: (item: QuickAddItem) => void;
  readonly speech: SpeechToText;
  readonly timeZone: string;
}

/**
 * The state machine behind the editors' quick-add field on both
 * platforms: phrase, submit (parse) and the dictation lifecycle (find a
 * time is the event form's own tool, `useFindTimeModel`). The two shells
 * re-implemented this separately
 * once and drifted — MicrophoneDeniedError was handled in different
 * phases on each platform, so whichever phase a platform's speech impl
 * threw it in, one of them showed the wrong copy. The hook checks it in
 * BOTH phases. Platform-specific model *availability* (status checks,
 * retry affordances) stays in the components.
 */
export const useQuickAddModel = ({
  fallbackDate,
  model,
  onApply,
  speech,
  timeZone,
}: QuickAddModelOptions) => {
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  // A parse takes seconds; the kind may be flipped meanwhile. The result
  // goes to the latest render's apply, which sees the editor as it is
  // then, not to the one submit was called from.
  const applyRef = useRef(onApply);
  applyRef.current = onApply;

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

  /** Reads the phrase (Enter, Apply, or the end of a dictation) and hands it on. */
  const submit = async (text: string = phrase) => {
    if (!text.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await parseQuickAdd(model, {
        ...(fallbackDate === undefined ? {} : { fallbackDate }),
        phrase: text,
        referenceDate: Temporal.Now.plainDateISO(timeZone).toString(),
        timeZone,
      });
      if (result.kind === 'rejected') {
        setError(result.reason);
        return;
      }
      applyRef.current(
        result.kind === 'task'
          ? { kind: 'task', prefill: result.prefill }
          : { kind: 'event', prefill: result.prefill },
      );
    } catch {
      setError('On-device model unavailable.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * The latest dictation start. Cancelling on unmount only stops a
   * recording that already started; one still preparing or waiting for
   * the microphone is aborted instead, and the adapter stops only what
   * that start opened. Cancelling it late would stop whichever recording
   * is current by then — possibly a newer field's.
   */
  const starting = useRef<AbortController | null>(null);

  const startRecording = async () => {
    const controller = new AbortController();
    starting.current = controller;
    setError(null);
    setVoice('preparing');
    try {
      // Prepare first: asking for the microphone before knowing dictation
      // can run would extract a permanent permission for nothing.
      await speech.prepare();
      // Preparing can take minutes (the locale's models download): a field
      // closed meanwhile must not switch the microphone on afterwards.
      if (controller.signal.aborted) {
        return;
      }
    } catch (error) {
      setVoice('idle');
      if (error instanceof SpeechUnsupportedError) {
        setVoiceAvailable(false);
        setError('Dictation is unavailable on this device.');
      } else if (error instanceof MicrophoneDeniedError) {
        setError('Microphone access is off — you can still type.');
      } else {
        // Installing the locale's models needs the network, so a failure
        // here is often transient — keep the mic and let them retry.
        setError("Couldn't set up dictation — try again.");
      }
      return;
    }
    try {
      await speech.startRecording({ signal: controller.signal });
      // Closed while the microphone was being granted: the adapter has
      // already stopped this start's stream.
      if (controller.signal.aborted) {
        return;
      }
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

  /** Stopping applies the transcript at once: no second tap after the microphone. */
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

  // Stop a forgotten recording, and never leave one running when the
  // field goes away (unmount cancels below).
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
      starting.current?.abort();
      void speech.cancelRecording();
    },
    [speech],
  );

  return {
    busy,
    error,
    phrase,
    setPhrase,
    startRecording,
    stopRecording,
    submit,
    voice,
    voiceAvailable,
  };
};
