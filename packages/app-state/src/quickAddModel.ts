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
import {
  grewSince,
  HOLD_MS,
  landedWords,
  maySay,
  CLICK_AFTER_UP_MS,
  micClick,
  micDown,
  micPress,
  micUp,
  pendingLine,
  phraseWords,
  sendPress,
  shouldListen,
  tapNeverCame,
  type WordCounts,
  wordCount,
} from './voiceLoop.ts';

/** A phrase that never pauses is sent this long after its first word rather than recorded until the app dies. */
const MAX_RECORDING_MS = 60_000;
/** Hands-free with nobody speaking turns the microphone off: it is never left listening to a room. */
const IDLE_LISTENING_MS = 30_000;

export type VoiceState = 'idle' | 'preparing' | 'recording' | 'transcribing';

/** A phrase sent at its pause, on its way (`useQuickAddModel`'s `flight`). */
interface Flight {
  /** Each recogniser's words when its pause ended: more is the phrase going on (`grewSince`). */
  readonly atPause: WordCounts;
  /** Let go of: words joined it, or a press read it again; the reading that replaced it owns everything. */
  dropped: boolean;
  /** Cut by the 60 s cap: words after it are the next phrase, never part of it (`landedWords`). */
  readonly forced: boolean;
  /** Where its audio ended, once read: cut there once it landed. */
  mark?: number | undefined;
  /** Its listening ended before it landed: it lands, and nothing is listened for after it. */
  orphan: boolean;
  /** The thread is reading it. */
  sent: boolean;
}

export interface QuickAddModelOptions {
  /**
   * The dictated phrase the thread is reading was let go of (words said
   * before it landed joined it, and the grown phrase is read instead): the
   * thread drops its answer.
   */
  readonly dropPhrase?: (() => void) | undefined;
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
 * hands-free: one press of the microphone opens it, the words stopping
 * sends what was said as a phrase (`listenForPhrase`), and the
 * microphone stays open — words said before that phrase landed join it,
 * words after it are the next phrase — until the microphone is pressed,
 * the form or the field is edited by hand, or nobody speaks for a while.
 * Held down, the microphone listens through any pause until it is let
 * go of (see `voiceLoop.ts` for the press). The two shells
 * re-implemented this separately
 * once and drifted — MicrophoneDeniedError was handled in different
 * phases on each platform, so whichever phase a platform's speech impl
 * threw it in, one of them showed the wrong copy. The hook checks it in
 * BOTH phases. Platform-specific model *availability* (status checks,
 * retry affordances) stays in the components.
 */
export const useQuickAddModel = ({
  dropPhrase,
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

  /** The words being read, while they are: the phrase on its way (`pendingLine`). */
  const [sending, setSending] = useState<string | null>(null);
  const busy = sending !== null;

  /**
   * Reads the phrase (Enter, Apply, or the end of a dictation, `heard`)
   * and hands it on. `field`: the words are the field's, which a turn
   * taken leaves empty; words the editor offered (`say`) leave it as it is.
   */
  const submit = async (text: string = phrase, heard?: Heard, { field = true } = {}) => {
    if (!text.trim()) {
      return;
    }
    setSending(text);
    setError(null);
    try {
      const message = await phraseRef.current(text, heard);
      if (message !== undefined) {
        setError(message);
      } else if (field) {
        // A thread keeps the words as a turn: the field is free for the next one.
        setPhrase('');
      }
    } catch {
      setError('On-device model unavailable.');
    } finally {
      setSending(null);
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
  /** The microphone is open: a phrase that lands is followed by the next one's ear. */
  const open = useRef(false);
  /** The listening is being finished and read: its ear's late "end", the cap and a press ask once. */
  const stopping = useRef(false);
  /** The ear of the phrase being listened to: its words so far, and when it ends. */
  const ear = useRef<PhraseListener | null>(null);
  /** Each recogniser's words since the listening began (it writes all of them, every phrase). */
  const texts = useRef<Record<WordsSource, string>>({ accurate: '', quick: '' });
  /** The words of the phrases that landed: the next phrase's words begin after them. */
  const landed = useRef<WordCounts>({ accurate: 0, quick: 0 });
  /** The microphone held down (hold to talk): no pause ends the phrase; lifting it sends. */
  const [holding, setHolding] = useState(false);
  const holdingRef = useRef(false);
  /**
   * The phrase sent at its pause and not landed yet, the microphone still
   * open: words that follow before it lands join it (`grewSince`), and it
   * is read again, grown. A flight lets go of nothing it does not own: one
   * that was `dropped` (it grew, or "that's all" read it again) leaves
   * everything to the reading that replaced it; one whose listening ended
   * meanwhile (`orphan`) still lands, and only closes the microphone's
   * wait for it.
   */
  const flight = useRef<Flight | null>(null);
  /** The recognisers that listen, as the start answered: every phrase's ear is told. */
  const sources = useRef<ReadonlyArray<WordsSource>>(['accurate', 'quick']);
  // The editor applying the last phrase: the next one waits to be sent.
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const holdWaiters = useRef<Array<() => void>>([]);
  useEffect(() => {
    if (!hold) {
      for (const resume of holdWaiters.current.splice(0)) {
        resume();
      }
    }
  }, [hold]);
  const afterHold = () =>
    holdRef.current
      ? new Promise<void>((resume) => {
          holdWaiters.current.push(resume);
        })
      : Promise.resolve();
  const dropRef = useRef(dropPhrase);
  dropRef.current = dropPhrase;

  const counts = (): WordCounts => ({
    accurate: wordCount(texts.current.accurate),
    quick: wordCount(texts.current.quick),
  });

  /** The phrase is dropped: its ear stops, its words go. */
  const closeEar = () => {
    ear.current?.stop();
    ear.current = null;
    setLive('');
  };

  /**
   * The phrase on its way is let go of: its reading no longer counts, and
   * the thread drops its answer (`dropPhrase`).
   */
  const dropFlight = () => {
    const was = flight.current;
    flight.current = null;
    if (!was) {
      return;
    }
    was.dropped = true;
    if (was.sent) {
      dropRef.current?.();
      setSending(null);
    }
  };

  /**
   * The listening ended with a phrase on its way: it still lands, and
   * nothing is listened for after it. Whether one is.
   */
  const orphanFlight = (): boolean => {
    const was = flight.current;
    flight.current = null;
    if (was) {
      was.orphan = true;
    }
    return was !== null;
  };

  const failed = (message: string) => {
    // A press under way when it failed: lifting it starts nothing.
    stopHolding();
    closeEar();
    orphanFlight();
    open.current = false;
    switchHandsFree(false);
    setHeard(false);
    setVoice('idle');
    setError(message);
  };

  /**
   * A new phrase's ear. `primed`: the words already said for it go in at
   * once (a phrase that grew, or one held after a pause), and it started.
   */
  const openEar = ({ primed = false } = {}) => {
    const listening = listenForPhrase(() => {
      if (ear.current === listening) {
        void pauseRef.current();
      }
    });
    ear.current = listening;
    listening.listensWith(sources.current);
    if (holdingRef.current) {
      // Held: no pause ends it; lifting the microphone does.
      listening.stop();
    }
    if (primed) {
      for (const source of ['accurate', 'quick'] as const) {
        listening.words(source, phraseWords(texts.current[source], landed.current[source]));
      }
      const started = listening.heard();
      setHeard(started);
      setLive(listening.text());
    }
    return listening;
  };

  /**
   * The phrase on its way landed (taken, refused, or heard as nothing):
   * its audio goes, its words are behind the next phrase's, and while the
   * microphone is open the next phrase is listened for.
   */
  const land = (own: Flight) => {
    if (own.dropped) {
      return;
    }
    if (own.orphan) {
      // The microphone's wait for it ends (`endVoice`); its listening is gone.
      setVoice((now) => (now === 'transcribing' && !stopping.current ? 'idle' : now));
      return;
    }
    if (flight.current !== own) {
      return;
    }
    flight.current = null;
    if (own.mark !== undefined) {
      speech.cut(own.mark);
    }
    landed.current = landedWords({ atPause: own.atPause, forced: own.forced, now: counts() });
    if (open.current && !stopping.current) {
      // After a cut phrase, what was said since is the next one's start.
      openEar({ primed: own.forced });
    }
  };

  /**
   * A dictated phrase in flight, handed to the thread. A phrase dropped
   * meanwhile (it grew) leaves everything to the one read instead.
   */
  const sendHeard = async (own: Flight, heard: Heard) => {
    setPhrase(heard.text);
    setSending(heard.text);
    setError(null);
    try {
      const message = await phraseRef.current(heard.text, heard);
      if (!own.dropped) {
        if (message === undefined) {
          setPhrase('');
        } else {
          setError(message);
        }
      }
    } catch {
      if (!own.dropped) {
        setError('On-device model unavailable.');
      }
    } finally {
      if (!own.dropped) {
        setSending(null);
        land(own);
      }
    }
  };

  /**
   * The phrase's words stopped: it is read and sent at once, the
   * microphone left open. What is said before it lands joins it; what
   * comes after is the next phrase.
   */
  const onPause = async (forced = false) => {
    if (holdingRef.current || stopping.current) {
      return;
    }
    ear.current?.stop();
    ear.current = null;
    setHeard(false);
    const own: Flight = { atPause: counts(), dropped: false, forced, orphan: false, sent: false };
    flight.current = own;
    try {
      const read = await speech.read();
      if (own.dropped) {
        return;
      }
      if (read === undefined) {
        // The listening went (ended, lost): nothing to send, nothing to cut.
        own.mark = undefined;
        land(own);
        return;
      }
      own.mark = read.mark;
      if (read.heard === undefined) {
        // Hands-free hears noise as often as words: it just listens on.
        setLive('');
        land(own);
        return;
      }
      // A phrase sent while the form still takes the last one in would read it as it was.
      await afterHold();
      if (own.dropped) {
        return;
      }
      // The words heard give way to the phrase as read, in one render.
      setLive('');
      own.sent = true;
      await sendHeard(own, read.heard);
    } catch {
      if (own.dropped) {
        return;
      }
      if (own.orphan) {
        land(own);
        setError('Could not transcribe that.');
        return;
      }
      starting.current = null;
      void speech.cancel();
      failed('Could not transcribe that.');
    }
  };
  const pauseRef = useRef(onPause);
  pauseRef.current = onPause;

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
    open.current = false;
    ear.current?.stop();
    ear.current = null;
    // Read again from where the last phrase landed: a phrase on its way goes with it.
    dropFlight();
    setVoice('transcribing');
    setHeard(false);
    try {
      const heard = await speech.finish();
      const text = heard?.text;
      // The words heard give way to the phrase as read, in one render.
      setLive('');
      if (!text) {
        if (!quiet) {
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

  /** A recogniser's words (all of them since the listening began), handled by the latest render. */
  const onWords = (source: WordsSource, text: string) => {
    texts.current[source] = text;
    const was = flight.current;
    if (!ear.current && was !== null) {
      if (
        !was.forced &&
        grewSince({ atPause: was.atPause, landed: landed.current, now: counts() })
      ) {
        // Said before the phrase landed: it is part of it.
        dropFlight();
        openEar({ primed: true });
      }
      return;
    }
    const listening = ear.current;
    if (!listening) {
      return;
    }
    if (listening.words(source, phraseWords(text, landed.current[source])) === 'start') {
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
    if (!open.current) {
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
      // A language picked in Settings since is prepared again, in view.
      if (!prepared.current || speech.isPrepared?.() === false) {
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
      texts.current = { accurate: '', quick: '' };
      landed.current = { accurate: 0, quick: 0 };
      sources.current = ['accurate', 'quick'];
      orphanFlight();
      // A phrase ends when its words stop: the ear sends it then.
      const listening = openEar();
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
            // Only this listening's words: a later one has its own ear.
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
        sources.current = started.sources;
        listening.listensWith(started.sources);
        open.current = true;
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
   * Hands-free ends: the microphone closes and what is being said goes
   * unheard; a start still preparing or waiting for the microphone is
   * given up. A phrase on its way still lands — it was said before the
   * user took over — and the microphone waits for it (`transcribing`), as
   * it waits for a phrase read at a press.
   */
  const endVoice = () => {
    switchHandsFree(false);
    setHeard(false);
    stopHolding();
    if (voice === 'preparing' || voice === 'recording' || arming.current) {
      starting.current?.abort();
      arming.current = false;
      open.current = false;
      closeEar();
      void speech.cancel();
      setVoice(orphanFlight() ? 'transcribing' : 'idle');
    }
  };
  const endRef = useRef(endVoice);
  endRef.current = endVoice;

  /**
   * "That's all": what was said is sent, and nothing more is listened
   * for. A phrase already on its way with nothing said after it just
   * lands; otherwise everything since the last phrase landed is read as one.
   */
  const send = () => {
    switchHandsFree(false);
    stopHolding();
    // After the pause the phrase has no ear until words follow it.
    if (
      sendPress({ inFlight: flight.current !== null, saidSince: ear.current !== null }) === 'land'
    ) {
      endVoice();
      return;
    }
    void stopRecording(!heard);
  };

  /**
   * Words the editor offers to say (another reading of dictated words),
   * sent as typed words are: they show as the phrase on its way, and
   * hands-free ends, as it does for words typed. The field keeps what it
   * holds. Not while a phrase is on its way (`maySay`).
   */
  const canSay = maySay({ busy, live, voice });
  const say = (text: string) => {
    if (!canSay) {
      return;
    }
    endVoice();
    void submit(text, undefined, { field: false });
  };

  /** The microphone pressed as a button (a click from the keyboard, VoiceOver), or tapped. */
  const press = () => {
    switch (micPress({ handsFree, voice })) {
      case 'listen': {
        setError(null);
        switchHandsFree(true);
        return;
      }
      case 'send': {
        send();
        return;
      }
      case 'end': {
        endVoice();
      }
    }
  };

  /** The finger (or mouse button) on the microphone: when it went down, and whether that started listening. */
  const down = useRef<{
    /** Its click came while it was down: a tap. */
    clicked: boolean;
    readonly listened: boolean;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  /** A release waiting for its click (`micUp` → `wait`): what the tap does, and when it gives up. */
  const awaitingClick = useRef<{
    readonly tap: () => void;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  /** When the microphone was last let go of: the click that follows a press is not another. */
  const lastUp = useRef(Number.NEGATIVE_INFINITY);

  /**
   * The hold, or the press under way, is over before the microphone is
   * let go of (sent, or dictation ended): letting go of it, and its click,
   * then do nothing more.
   */
  function stopHolding() {
    if (down.current) {
      clearTimeout(down.current.timer);
      down.current = null;
    }
    holdingRef.current = false;
    setHolding(false);
  }

  /**
   * Held long enough: hold to talk. No pause ends the phrase, and a
   * phrase still on its way is part of it (it is read again, with what is
   * said now, once the microphone is lifted).
   */
  const beginHold = () => {
    holdingRef.current = true;
    setHolding(true);
    ear.current?.stop();
    if (ear.current === null && flight.current !== null) {
      dropFlight();
      openEar({ primed: true });
    }
  };
  const holdRefFn = useRef(beginHold);
  holdRefFn.current = beginHold;

  /** The microphone pressed down: off, it listens at once (`micDown`). */
  const micDownPress = () => {
    if (down.current) {
      clearTimeout(down.current.timer);
    }
    const listened = micDown({ handsFree, voice }) === 'listen';
    if (listened) {
      setError(null);
      switchHandsFree(true);
    }
    down.current = {
      clicked: false,
      listened,
      timer: setTimeout(() => holdRefFn.current(), HOLD_MS),
    };
  };

  /** The microphone let go of (`micUp`): a hold sends, a tap is a press. */
  const micUpPress = () => {
    // Also a press ended under the finger (sent, or dictation ended): its click is not another.
    lastUp.current = Date.now();
    const was = down.current;
    if (!was) {
      return;
    }
    clearTimeout(was.timer);
    down.current = null;
    const held = holdingRef.current;
    stopHolding();
    const release = (clicked: boolean) =>
      micUp({ clicked, handsFree, held, listened: was.listened, voice });
    const action = release(was.clicked);
    if (action === 'wait') {
      awaitingClick.current = {
        tap: () => {
          act(release(true));
        },
        timer: setTimeout(() => {
          awaitingClick.current = null;
          if (tapNeverCame({ listened: was.listened }) === 'end') {
            endRef.current();
          }
        }, CLICK_AFTER_UP_MS),
      };
      return;
    }
    act(action);
  };

  /** What a release does (`micUp`), once it is known to be a tap or a hold. */
  const act = (action: 'end' | 'keep' | 'listen' | 'send' | 'wait') => {
    switch (action) {
      case 'send': {
        send();
        return;
      }
      case 'end': {
        endVoice();
        return;
      }
      case 'listen': {
        setError(null);
        switchHandsFree(true);
        return;
      }
      case 'keep':
      case 'wait':
    }
  };

  /** The microphone's click: after a press it handled, nothing more; from the keyboard, a press. */
  const toggleVoice = () => {
    const waiting = awaitingClick.current;
    switch (
      micClick({
        pressing: down.current !== null,
        sinceUpMs: Date.now() - lastUp.current,
        waiting: waiting !== null,
      })
    ) {
      case 'mark': {
        down.current!.clicked = true;
        return;
      }
      case 'confirm': {
        clearTimeout(waiting!.timer);
        awaitingClick.current = null;
        waiting!.tap();
        return;
      }
      case 'press': {
        press();
        return;
      }
      case 'ignore':
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

  // Send a phrase that never pauses (held, the hold ends with it), and
  // never leave one running when the field goes away (unmount cancels below).
  useEffect(() => {
    if (voice !== 'recording' || !heard) {
      return;
    }
    const timer = setTimeout(() => {
      if (holdingRef.current) {
        // As a hold let go of: sent, and nothing more is listened for.
        switchHandsFree(false);
        stopHolding();
        void stopRef.current();
      } else {
        // Cut here for good: what follows is the next phrase.
        void pauseRef.current(true);
      }
    }, MAX_RECORDING_MS);
    return () => {
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart the cap per phrase
  }, [voice, heard]);

  // Listening to a silent room for long: hands-free gives up. Not while a
  // phrase is read or the microphone is held.
  useEffect(() => {
    if (!handsFree || voice !== 'recording' || heard || busy || holding) {
      return;
    }
    const timer = setTimeout(endVoice, IDLE_LISTENING_MS);
    return () => {
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart the wait per silence
  }, [handsFree, voice, heard, busy, holding]);

  useEffect(
    () => () => {
      starting.current?.abort();
      ear.current?.stop();
      if (down.current) {
        clearTimeout(down.current.timer);
      }
      if (awaitingClick.current) {
        clearTimeout(awaitingClick.current.timer);
      }
      // A phrase still on its way belongs to an editor that is gone: its
      // answer lands nowhere, and nothing it would cut or open is its own.
      open.current = false;
      if (flight.current) {
        flight.current.dropped = true;
        flight.current = null;
      }
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
    /** The microphone is held down: it listens through any pause until let go of. */
    holding,
    /**
     * Words typed or dictated into the field and not sent yet: closing
     * the editor would lose them (`editorUnsaved`).
     */
    held: live.trim() !== '' || (phrase.trim() !== '' && phrase !== given),
    /**
     * The thread's line for the phrase on its way: its words while it is
     * spoken, then the phrase while it is read.
     */
    pending: pendingLine({ busy, live, phrase: sending ?? phrase }),
    phrase,
    /** The microphone pressed down, and let go of: a hold talks until let go, a tap is `toggleVoice`. */
    micDown: micDownPress,
    micUp: micUpPress,
    /** Words the editor offers, said as if typed (`say`). */
    say,
    /** Offered words may be said now: no phrase is on its way (`maySay`). */
    canSay,
    setPhrase,
    submit,
    toggleVoice,
    voice,
    voiceAvailable,
  };
};
