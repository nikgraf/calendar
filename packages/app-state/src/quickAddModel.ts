import {
  type Heard,
  listenForPhrase,
  MicrophoneDeniedError,
  type PhraseListener,
  SpeechUnsupportedError,
  type SpeechToText,
  type WordsSource,
} from '@calendar/ai';
import { useCallback, useEffect, useRef, useState } from 'react';
import { micPress, pendingLine, shouldListen } from './voiceLoop.ts';

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
  /** The form is still taking the last phrase in: hands-free waits before listening again. */
  readonly hold?: boolean | undefined;
  /** What the field holds on open (the Create lesson's phrase); empty otherwise. */
  readonly initialText?: string | undefined;
  /**
   * There is nothing to say a phrase to (the editor shows an older step):
   * hands-free dictation ends as this turns true — a microphone must not
   * stay open behind a control that is off.
   */
  readonly off?: boolean | undefined;
  /**
   * The editor's thread reads the words as a first phrase or a change
   * (`useDraftThread`). Resolves an error message, or nothing when the
   * phrase was taken; the field is cleared then. `heard`: the dictated
   * phrase as the recogniser read it, its other readings with it; none
   * for words typed.
   */
  readonly onPhrase: (text: string, heard?: Heard) => Promise<string | undefined>;
  readonly speech: SpeechToText;
}

/**
 * The state machine behind the editors' quick-add field on both
 * platforms: phrase, submit (to the thread) and the dictation lifecycle (find a
 * time is the event form's own tool, `useFindTimeModel`). Dictation is
 * hands-free: one press of the microphone listens, the words stopping
 * sends what was said as a phrase (`listenForPhrase`), and it listens again — until the microphone is
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
  hold = false,
  initialText,
  off = false,
  onPhrase,
  speech,
}: QuickAddModelOptions) => {
  const [phrase, setPhrase] = useState(initialText ?? '');
  // What the editor itself put in the field (the Create lesson's phrase,
  // its demo's next one): not words of the person's, so not `held`.
  const [given, setGiven] = useState(initialText ?? '');
  // Stable: the demo puts its next phrase in from an effect keyed on it.
  const give = useCallback((text: string) => {
    setGiven(text);
    setPhrase(text);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceState>('idle');
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [heard, setHeard] = useState(false);
  /** The words of the phrase being spoken, as the recognisers write them. */
  const [live, setLive] = useState('');
  // Read after awaits: a phrase that finishes reading must know whether
  // hands-free ended meanwhile.
  const handsFreeRef = useRef(false);
  const switchHandsFree = (on: boolean) => {
    handsFreeRef.current = on;
    setHandsFree(on);
  };
  // A reading takes seconds: the words go to the latest render's thread.
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

  /** Reads the phrase (Enter, Apply, or the end of a dictation, `heard`) and hands it on. */
  const submit = async (text: string = phrase, heard?: Heard) => {
    if (!text.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const message = await phraseRef.current(text, heard);
      if (message === undefined) {
        // A thread keeps the words as a turn: the field is free for the next one.
        setPhrase('');
      } else {
        setError(message);
      }
    } catch {
      setError('On-device model unavailable.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Words the editor offers to say (another reading of dictated words):
   * sent as typed words are, through the field — so they show as the
   * phrase on its way, and stay there with the message if they fail. Not
   * while a phrase is read.
   */
  const say = (text: string) => {
    if (busy) {
      return;
    }
    setPhrase(text);
    void submit(text);
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
  /** The ear of the phrase being listened to: its words so far, and when it ends. */
  const ear = useRef<PhraseListener | null>(null);

  /** The phrase is dropped: its ear stops, its words go. */
  const closeEar = () => {
    ear.current?.stop();
    ear.current = null;
    setLive('');
  };

  const failed = (message: string) => {
    closeEar();
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
    // Its ear is done: words still on their way after the press must not
    // reach the next recording. They stay on show until the phrase is read.
    starting.current = null;
    ear.current?.stop();
    ear.current = null;
    setVoice('transcribing');
    setHeard(false);
    try {
      const heard = await speech.finish();
      const text = heard?.text;
      // The words heard give way to the phrase as read, in one render.
      setLive('');
      if (!text) {
        // Hands-free hears noise as often as words: it just listens again.
        if (!handsFreeRef.current && !quiet) {
          setError("Didn't catch that — try again.");
        }
        return;
      }
      setPhrase(text);
      await submit(text, heard);
    } catch {
      switchHandsFree(false);
      setError('Could not transcribe that.');
    } finally {
      stopping.current = false;
      setLive('');
      setVoice('idle');
    }
  };
  const stopRef = useRef(stopRecording);
  stopRef.current = stopRecording;

  /** A recogniser's words, handled by the latest render. */
  const onWords = (source: WordsSource, text: string) => {
    const listening = ear.current;
    if (!listening) {
      return;
    }
    if (listening.words(source, text) === 'start') {
      setHeard(true);
      // Speaking again is the answer to the last phrase's message.
      setError(null);
    }
    setLive(listening.text());
  };
  const wordsRef = useRef(onWords);
  wordsRef.current = onWords;

  /** The phrase went with its recognisers: nothing will end it, so it ends here. */
  const onLost = () => {
    if (!ear.current) {
      return;
    }
    starting.current = null;
    void speech.cancel();
    failed('Dictation stopped — try again.');
  };
  const lostRef = useRef(onLost);
  lostRef.current = onLost;

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
      // The phrase ends when its words stop: the ear sends it then.
      const listening = listenForPhrase(() => {
        if (ear.current === listening) {
          void stopRef.current();
        }
      });
      ear.current = listening;
      /** This start came to nothing: its ear goes, a newer one stays. */
      const drop = () => {
        listening.stop();
        if (ear.current === listening) {
          closeEar();
        }
      };
      try {
        const started = await speech.start({
          onLost: () => {
            if (starting.current === controller && !controller.signal.aborted) {
              lostRef.current();
            }
          },
          onWords: (source, text) => {
            // Only this recording's words: a later one has its own ear.
            if (starting.current === controller && !controller.signal.aborted) {
              wordsRef.current(source, text);
            }
          },
          signal: controller.signal,
        });
        // Ended while the microphone was being granted: the adapter has
        // already stopped what this start opened.
        if (controller.signal.aborted || !started) {
          drop();
          return;
        }
        listening.listensWith(started.sources);
        setVoice('recording');
      } catch (error) {
        drop();
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
      closeEar();
      void speech.cancel();
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

  // Nothing to say a phrase to any more: the listening ends with it.
  useEffect(() => {
    if (off && handsFreeRef.current) {
      endVoice();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handled once, as it turns off
  }, [off]);

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
      ear.current?.stop();
      void speech.cancel();
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
    /** The editor puts words in the field itself (a demo's phrase): they are not the person's. */
    give,
    /** Hands-free dictation is on, between phrases included. */
    handsFree,
    /** A first word of the phrase being recorded was heard. */
    heard,
    /**
     * Words typed or dictated into the field and not sent yet: closing
     * the editor would lose them (`editorUnsaved`).
     */
    held: live.trim() !== '' || (phrase.trim() !== '' && phrase !== given),
    /**
     * The thread's line for the phrase on its way: its words while it is
     * spoken, then the phrase while it is read.
     */
    pending: pendingLine({ busy, live, phrase }),
    phrase,
    /** Words the editor offers, said as if typed (`say`). */
    say,
    setPhrase,
    submit,
    toggleVoice,
    voice,
    voiceAvailable,
  };
};
