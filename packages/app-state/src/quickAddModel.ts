import {
  MicrophoneDeniedError,
  parseQuickAdd,
  SpeechUnsupportedError,
  type LanguageModel,
  type SpeechEvent,
  type SpeechToText,
} from '@calendar/ai';
import { Temporal } from '@calendar/core';
import { useEffect, useRef, useState } from 'react';
import type { QuickAddItem } from './quickAddItem.ts';
import { micPress, shouldListen } from './voiceLoop.ts';

/** A phrase that never pauses is sent after this long rather than recorded until the app dies. */
const MAX_RECORDING_MS = 60_000;
/** Hands-free with nobody speaking turns the microphone off: it is never left listening to a room. */
const IDLE_LISTENING_MS = 30_000;

export type VoiceState = 'idle' | 'preparing' | 'recording' | 'transcribing';

export interface QuickAddModelOptions {
  /**
   * Moves whenever the form is edited by hand: hands-free dictation ends
   * there, since the user has taken over.
   */
  readonly editKey?: number | undefined;
  /** Undated phrases land on this day (the day being viewed, or the editor's). */
  readonly fallbackDate?: string | undefined;
  /** The form is still taking the last phrase in: hands-free waits before listening again. */
  readonly hold?: boolean | undefined;
  /** What the field holds on open (the Create lesson's phrase); empty otherwise. */
  readonly initialText?: string | undefined;
  readonly model: LanguageModel;
  /**
   * Receives what the phrase was understood as: the editor below the
   * field fills its form from it. The phrase stays in the field, so what
   * was read can be compared with what the form shows.
   */
  readonly onApply: (item: QuickAddItem) => void;
  /**
   * Takes the phrase over instead of `parseQuickAdd` + `onApply`: a thread
   * reads it as a first phrase or a refinement. Resolves an error message,
   * or nothing when the phrase was taken; the field is cleared then.
   */
  readonly onPhrase?: ((text: string) => Promise<string | undefined>) | undefined;
  readonly speech: SpeechToText;
  readonly timeZone: string;
}

/**
 * The state machine behind the editors' quick-add field on both
 * platforms: phrase, submit (parse) and the dictation lifecycle (find a
 * time is the event form's own tool, `useFindTimeModel`). Dictation is
 * hands-free: one press of the microphone listens, a pause sends what
 * was said as a phrase, and it listens again — until the microphone is
 * pressed, the form or the field is edited by hand, or nobody speaks for
 * a while (see `voiceLoop.ts` for the press). The two shells
 * re-implemented this separately
 * once and drifted — MicrophoneDeniedError was handled in different
 * phases on each platform, so whichever phase a platform's speech impl
 * threw it in, one of them showed the wrong copy. The hook checks it in
 * BOTH phases. Platform-specific model *availability* (status checks,
 * retry affordances) stays in the components.
 */
export const useQuickAddModel = ({
  editKey,
  fallbackDate,
  hold = false,
  initialText,
  model,
  onApply,
  onPhrase,
  speech,
  timeZone,
}: QuickAddModelOptions) => {
  const [phrase, setPhrase] = useState(initialText ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [heard, setHeard] = useState(false);
  // Read after awaits: a phrase that finishes reading must know whether
  // hands-free ended meanwhile.
  const handsFreeRef = useRef(false);
  const switchHandsFree = (on: boolean) => {
    handsFreeRef.current = on;
    setHandsFree(on);
  };
  // A parse takes seconds; the kind may be flipped meanwhile. The result
  // goes to the latest render's apply, which sees the editor as it is
  // then, not to the one submit was called from.
  const applyRef = useRef(onApply);
  applyRef.current = onApply;
  const phraseRef = useRef(onPhrase);
  phraseRef.current = onPhrase;

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
      const takeOver = phraseRef.current;
      if (takeOver) {
        const message = await takeOver(text);
        if (message === undefined) {
          // A thread keeps the words as a turn: the field is free for the next one.
          setPhrase('');
        } else {
          setError(message);
        }
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
  /** A start is under way: hands-free never opens the microphone twice. */
  const arming = useRef(false);
  /** The locale's models were installed once: listening again skips straight to the microphone. */
  const prepared = useRef(false);
  /** A recording is being stopped and read: its ear's late "end", the cap and a press ask once. */
  const stopping = useRef(false);

  const failed = (message: string) => {
    switchHandsFree(false);
    setHeard(false);
    setVoice('idle');
    setError(message);
  };

  /**
   * Stopping applies the transcript at once: no second tap after the
   * microphone. `quiet`: nothing was heard, so nothing coming back needs
   * no message.
   */
  const stopRecording = async (quiet = false) => {
    if (stopping.current) {
      return;
    }
    stopping.current = true;
    // Its ear is done: a block still queued in the worklet may report an
    // "end" after the press — it must not stop the next recording.
    starting.current = null;
    setVoice('transcribing');
    setHeard(false);
    try {
      const text = await speech.stopRecording();
      if (!text) {
        // Hands-free hears noise as often as words: it just listens again.
        if (!handsFreeRef.current && !quiet) {
          setError("Didn't catch that — try again.");
        }
        return;
      }
      setPhrase(text);
      await submit(text);
    } catch {
      switchHandsFree(false);
      setError('Could not transcribe that.');
    } finally {
      stopping.current = false;
      setVoice('idle');
    }
  };

  /** What the recording's ear says, handled by the latest render. */
  const onSpeech = (event: SpeechEvent) => {
    if (event === 'start') {
      setHeard(true);
      // Speaking again is the answer to the last phrase's message.
      setError(null);
    } else {
      void stopRecording();
    }
  };
  const speechRef = useRef(onSpeech);
  speechRef.current = onSpeech;

  const listen = async () => {
    const controller = new AbortController();
    starting.current = controller;
    arming.current = true;
    setHeard(false);
    try {
      if (!prepared.current) {
        setVoice('preparing');
        try {
          // Prepare first: asking for the microphone before knowing dictation
          // can run would extract a permanent permission for nothing.
          await speech.prepare();
          prepared.current = true;
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          if (error instanceof SpeechUnsupportedError) {
            setVoiceAvailable(false);
            failed('Dictation is unavailable on this device.');
          } else if (error instanceof MicrophoneDeniedError) {
            failed('Microphone access is off — you can still type.');
          } else {
            // Installing the locale's models needs the network, so a failure
            // here is often transient — keep the mic and let them retry.
            failed("Couldn't set up dictation — try again.");
          }
          return;
        }
        // Preparing can take minutes (the locale's models download): a field
        // closed or a dictation ended meanwhile must not switch the
        // microphone on afterwards.
        if (controller.signal.aborted) {
          return;
        }
      }
      try {
        await speech.startRecording({
          onSpeech: (event) => {
            // Only this recording's ear: a later one has its own.
            if (starting.current === controller && !controller.signal.aborted) {
              speechRef.current(event);
            }
          },
          signal: controller.signal,
        });
        // Ended while the microphone was being granted: the adapter has
        // already stopped this start's stream.
        if (controller.signal.aborted) {
          return;
        }
        setVoice('recording');
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        failed(
          error instanceof MicrophoneDeniedError
            ? 'Microphone access is off — you can still type.'
            : 'Could not start recording.',
        );
      }
    } finally {
      if (starting.current === controller) {
        arming.current = false;
      }
    }
  };

  /**
   * Hands-free ends: a recording is dropped unheard, a start still
   * preparing or waiting for the microphone is given up. A phrase being
   * read still lands — it was said before the user took over.
   */
  const endVoice = () => {
    switchHandsFree(false);
    setHeard(false);
    if (voice === 'preparing' || voice === 'recording' || arming.current) {
      starting.current?.abort();
      arming.current = false;
      void speech.cancelRecording();
      setVoice('idle');
    }
  };

  /** The microphone button. */
  const toggleVoice = () => {
    switch (micPress({ handsFree, voice })) {
      case 'listen': {
        setError(null);
        switchHandsFree(true);
        return;
      }
      case 'send': {
        switchHandsFree(false);
        void stopRecording(!heard);
        return;
      }
      case 'end': {
        endVoice();
      }
    }
  };

  // Hands-free listens whenever it is idle: the first press, and again
  // after each phrase once the form has taken it in.
  useEffect(() => {
    if (shouldListen({ handsFree, hold, voice }) && !arming.current) {
      void listen();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- these name exactly when to listen
  }, [handsFree, hold, voice]);

  // The form edited by hand: the user took over.
  const editSeen = useRef(editKey);
  useEffect(() => {
    if (editKey === editSeen.current) {
      return;
    }
    editSeen.current = editKey;
    if (handsFreeRef.current) {
      endVoice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- an edit is handled once, when it arrives
  }, [editKey]);

  // Send a phrase that never pauses, and never leave one running when the
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

  // Listening to a silent room for long: hands-free gives up.
  useEffect(() => {
    if (!handsFree || voice !== 'recording' || heard) {
      return;
    }
    const timer = setTimeout(endVoice, IDLE_LISTENING_MS);
    return () => {
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart the wait per silence
  }, [handsFree, voice, heard]);

  useEffect(
    () => () => {
      starting.current?.abort();
      void speech.cancelRecording();
    },
    [speech],
  );

  return {
    busy,
    /** The field took the error in (focused or typed into): it shows the words again. */
    dismissError: () => setError(null),
    /** Hands-free ends (a key typed into the field: the user took over). */
    endVoice,
    error,
    /** Hands-free dictation is on, between phrases included. */
    handsFree,
    /** The phrase being recorded has begun. */
    heard,
    phrase,
    setPhrase,
    submit,
    toggleVoice,
    voice,
    voiceAvailable,
  };
};
