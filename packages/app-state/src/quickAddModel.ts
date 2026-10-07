import {
  MicrophoneDeniedError,
  parseQuickAdd,
  SpeechUnsupportedError,
  type FindTimeOutcome,
  type LanguageModel,
  type QuickAddTaskPrefill,
  type SpeechToText,
} from '@calendar/ai';
import { Temporal, type FreeSlot } from '@calendar/core';
import { useEffect, useRef, useState } from 'react';
import type { EventEditorPrefill } from './editorModel.ts';
import { convertQuickAddItem, type QuickAddReview } from './quickAddReview.ts';

/** A forgotten recording stops itself rather than running until the app dies. */
const MAX_RECORDING_MS = 60_000;

export type QuickAddMode = 'add' | 'find';
export type VoiceState = 'idle' | 'preparing' | 'recording' | 'transcribing';

export interface QuickAddModelOptions {
  /** Undated phrases land on this day (iOS: the day being viewed). */
  readonly fallbackDate?: string | undefined;
  /** The find-a-time pipeline (`makeFindSlots` from @calendar/ai). */
  readonly findSlots: (phrase: string) => Promise<FindTimeOutcome | { readonly reason: string }>;
  readonly model: LanguageModel;
  /** Receives the parsed prefill; the caller opens its editor (and may close the bar). */
  readonly onPrefill: (prefill: EventEditorPrefill) => void;
  /**
   * Receives a phrase understood as a to-do; the caller opens its task
   * editor. Without it a to-do is handed to `onPrefill` as an event.
   */
  readonly onTaskPrefill?: ((prefill: QuickAddTaskPrefill) => void) | undefined;
  /**
   * Hold a parse in `review` (an "Understood as" card with an Event/Task
   * toggle) instead of handing it on at once; `confirmReview` hands it on.
   */
  readonly reviewFirst?: boolean | undefined;
  readonly speech: SpeechToText;
  readonly timeZone: string;
}

/**
 * The state machine behind the quick-add bars (iOS QuickAddBar, desktop
 * ⌘K CommandBar): mode, phrase, submit (parse or find-a-time), slot
 * pick, and the dictation lifecycle. The two bars re-implemented this
 * separately and drifted — MicrophoneDeniedError was handled in
 * different phases on each platform, so whichever phase a platform's
 * speech impl threw it in, one of them showed the wrong copy. The hook
 * checks it in BOTH phases. Platform-specific model *availability*
 * (status checks, retry affordances) stays in the components.
 */
export const useQuickAddModel = ({
  fallbackDate,
  findSlots,
  model,
  onPrefill,
  onTaskPrefill,
  reviewFirst = false,
  speech,
  timeZone,
}: QuickAddModelOptions) => {
  const [mode, setModeState] = useState<QuickAddMode>('add');
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<FindTimeOutcome | null>(null);
  const [review, setReview] = useState<QuickAddReview | null>(null);
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [voiceAvailable, setVoiceAvailable] = useState(false);

  /** Hands an understood item to the caller's editor and clears the phrase. */
  const deliver = (item: QuickAddReview) => {
    setPhrase('');
    setReview(null);
    if (item.kind === 'event') {
      onPrefill(item.prefill);
    } else if (onTaskPrefill) {
      onTaskPrefill(item.prefill);
    } else {
      onPrefill(convertQuickAddItem(item, 'event').prefill as EventEditorPrefill);
    }
  };

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

  /** Switching modes clears results and errors from the other one. */
  const setMode = (next: QuickAddMode) => {
    setModeState(next);
    setError(null);
    setFound(null);
    setReview(null);
  };

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
        ...(fallbackDate === undefined ? {} : { fallbackDate }),
        phrase: text,
        referenceDate: Temporal.Now.plainDateISO(timeZone).toString(),
        timeZone,
      });
      if (result.kind === 'rejected') {
        setError(result.reason);
        return;
      }
      const item: QuickAddReview =
        result.kind === 'task'
          ? { kind: 'task', prefill: result.prefill }
          : { kind: 'event', prefill: result.prefill };
      if (reviewFirst) {
        setReview(item);
        return;
      }
      deliver(item);
    } catch {
      setError('On-device model unavailable.');
    } finally {
      setBusy(false);
    }
  };

  const pickSlot = (slot: FreeSlot) => {
    const title = found?.title ?? '';
    setFound(null);
    setPhrase('');
    onPrefill({
      date: slot.date,
      endTime: slot.endTime,
      isAllDay: false,
      startTime: slot.startTime,
      title,
    });
  };

  /**
   * The latest dictation start. Cancelling on unmount only stops a
   * recording that already started; one still preparing or waiting for
   * the microphone is aborted instead, and the adapter stops only what
   * that start opened. Cancelling it late would stop whichever recording
   * is current by then — possibly a newer bar's.
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
      // Preparing can take minutes (the locale's models download): a bar
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
  // goes away (unmount cancels below).
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
    /** Hands the reviewed item to the caller's editor (as the kind it shows now). */
    confirmReview: () => {
      if (review) {
        deliver(review);
      }
    },
    /** Drops the review; the phrase stays for another try. */
    dismissReview: () => setReview(null),
    error,
    found,
    mode,
    phrase,
    pickSlot,
    /** What the phrase was understood as, while `reviewFirst` holds it for a look. */
    review,
    setMode,
    setPhrase,
    /** The review's Event/Task toggle: the same phrase as the other kind. */
    setReviewKind: (kind: QuickAddReview['kind']) =>
      setReview((current) => (current ? convertQuickAddItem(current, kind) : current)),
    startRecording,
    stopRecording,
    submit,
    voice,
    voiceAvailable,
  };
};
