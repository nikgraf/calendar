import {
  heardFromSegments,
  listenedLocale,
  MicrophoneDeniedError,
  type PhraseRead,
  SpeechUnsupportedError,
  type SpeechToText,
  type WordsSource,
} from '@calendar/ai';
import { loadSpeechModule, type SpeechRead } from '../modules/solunivo-speech/index.ts';
import { recordDictationError } from './crashLog.ts';
import { dictationLanguage, secondLanguage } from './dictationLanguages.ts';
import { voiceProcessing } from './voiceProcessing.ts';

/** The iPhone's own language: what dictation listens in unless Settings › Dictation picks another. */
export const deviceLocale = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
};

/** Locale for recognition, so dictating German transcribes German: Settings › Dictation › Language. */
export const dictationLocale = (): string =>
  listenedLocale(dictationLanguage.get(), deviceLocale());

const unsupported = () =>
  new SpeechUnsupportedError({ message: 'Speech recognition is not built into this app.' });

type Native = NonNullable<ReturnType<typeof loadSpeechModule>>;

/**
 * The languages to listen in, as Settings › Dictation has them now. A
 * binary built before the module took the second language (a stale local
 * dev client) is asked as before: its functions take one argument fewer.
 */
const languagesFor = (native: Native) =>
  native.languages === undefined
    ? { locale: deviceLocale(), second: undefined }
    : { locale: dictationLocale(), second: secondLanguage.get() };

/**
 * The languages last prepared: a phrase in others (picked in Settings
 * while an editor stayed open) prepares them first, since only preparing
 * installs a language's assets.
 */
let preparedFor: string | undefined;

const prepareIn = async (native: Native) => {
  const { locale, second } = languagesFor(native);
  try {
    // Installs the locale's models; a no-op once present.
    await (second === undefined
      ? (native.prepare as (locale: string) => Promise<void>)(locale)
      : native.prepare(locale, second));
    preparedFor = `${locale} ${second ?? ''}`;
  } catch (error) {
    // Distinguish "this device or locale never will" from "that attempt
    // failed" — installing models needs the network, and a download
    // failure must stay retryable rather than hiding dictation for good.
    const message = String(error);
    if (/not supported|unsupported|unavailable/i.test(message)) {
      throw new SpeechUnsupportedError({ message });
    }
    throw error;
  }
};

/** Words of a listening, by recogniser. */
type Said = Record<WordsSource, string>;

/**
 * The listening: the module's session for it now, its words' subscription,
 * and what the caller gave its start. `said`: each recogniser's words of
 * the whole listening, which a session opened again after a failed reading
 * goes on from.
 */
interface Listening {
  /** Which start opened it (`starts`): a fallback opens nothing again once a newer one began. */
  readonly epoch: number;
  /** The session is being read the fallback way (`readAfresh`): its phrase, once read. */
  fallback?: Promise<SpeechRead | undefined> | undefined;
  readonly onLost: (() => void) | undefined;
  readonly onWords: (source: WordsSource, text: string) => void;
  /** The module is reading the phrase with the microphone open (`read`), not answered yet. */
  reading?: Promise<unknown> | undefined;
  readonly remove: () => void;
  readonly said: Said;
  readonly session: number;
  /**
   * A phrase read the fallback way and not yet let go of (`cut`): its
   * audio went with the session it was in, so a reading that follows
   * (the phrase grew) begins with it.
   */
  uncut?: SpeechRead | undefined;
}

let current: Listening | undefined;
let sessions = 0;
/** Starts asked for so far, counted as each begins: before its microphone has opened. */
let starts = 0;

const nothingSaid = (): Said => ({ accurate: '', quick: '' });

const joinWords = (before: string, text: string) =>
  before === '' ? text : text === '' ? before : `${before} ${text}`;

/**
 * Opens the microphone for a new session of the module. Its words reach
 * `onWords` after `before`, the words of the listening's earlier sessions,
 * so the caller keeps seeing all of them since its listening began.
 */
const openSession = async (
  native: Native,
  onWords: Listening['onWords'],
  before: Said,
): Promise<{
  readonly remove: () => void;
  readonly said: Said;
  readonly session: number;
  readonly sources: ReadonlyArray<WordsSource>;
}> => {
  const { locale, second } = languagesFor(native);
  sessions += 1;
  const session = sessions;
  const said = { ...before };
  // Subscribed before the microphone opens: no word arrives unheard.
  const subscription = native.addListener('onWords', (event) => {
    if (event.session === session) {
      said[event.source] = joinWords(before[event.source], event.text);
      onWords(event.source, said[event.source]);
    }
  });
  const remove = () => {
    subscription.remove();
  };
  try {
    const { sources } = await (second === undefined
      ? (
          native.start as (
            session: number,
            locale: string,
            voiceProcessing: boolean,
          ) => ReturnType<Native['start']>
        )(session, locale, voiceProcessing.get())
      : native.start(session, locale, voiceProcessing.get(), second));
    return { remove, said, session, sources };
  } catch (error) {
    remove();
    throw error;
  }
};

const heardIn = (result: SpeechRead) =>
  heardFromSegments(result.segments, result.other, result.parakeet?.text);

const joinedOr = (before: string | undefined, text: string | undefined) => {
  const joined = joinWords(before ?? '', text ?? '');
  return joined === '' ? undefined : joined;
};

/** A reading after the phrase read before it, as one. Parakeet's only when it read both. */
const after = (before: SpeechRead | undefined, read: SpeechRead): SpeechRead => {
  // A noise pause read that way and never cut holds nothing to go before.
  if (!before || before.segments.length === 0) {
    return read;
  }
  // Nothing followed it (no audio, so no other reading either).
  if (read.segments.length === 0) {
    return before;
  }
  const other = joinedOr(before.other, read.other);
  const parakeet =
    before.parakeet && read.parakeet
      ? {
          raw: joinWords(before.parakeet.raw, read.parakeet.raw),
          replacements: [...before.parakeet.replacements, ...read.parakeet.replacements],
          text: joinWords(before.parakeet.text, read.parakeet.text),
        }
      : undefined;
  return {
    ...(other === undefined ? {} : { other }),
    ...(parakeet === undefined ? {} : { parakeet }),
    segments: [...before.segments, ...read.segments],
  };
};

const SOURCES = ['accurate', 'quick'] as const;

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * The words before a reopened session, the same number for each
 * recogniser that wrote any: the one that lagged when the session closed
 * (the accurate one writes in bursts) will never write the rest of that
 * phrase, and its first word in the new session must count as a new
 * word, as the other's does, not as a late one of the phrase just read.
 */
const levelled = (said: Said): Said => {
  const longest = SOURCES.map((source) => said[source]).reduce((a, b) =>
    wordsOf(b) > wordsOf(a) ? b : a,
  );
  const level = (text: string) => (text === '' ? text : longest);
  return { accurate: level(said.accurate), quick: level(said.quick) };
};

/** Told a moment later: after the phrase read with it reached the caller, so its message stays. */
const later = (lost: (() => void) | undefined) => {
  if (lost) {
    setTimeout(lost, 0);
  }
};

/**
 * Opens the microphone again after a fallback reading, while the
 * listening is still the current one; the reading stays until its `cut`.
 * `read` undefined: the module no longer held the session.
 */
const reopen = async (native: Native, active: Listening, read: SpeechRead | undefined) => {
  // Given up, finished or replaced; or a newer start is on its way, whose
  // session a reopened one would replace in the module.
  const superseded = () => current !== active || starts !== active.epoch;
  if (current !== active) {
    return;
  }
  active.remove();
  if (superseded()) {
    current = undefined;
    return;
  }
  if (read === undefined) {
    // The module let the listening go: nothing will end it now.
    current = undefined;
    later(active.onLost);
    return;
  }
  const before = levelled(active.said);
  try {
    const next = await openSession(native, active.onWords, before);
    if (!superseded()) {
      current = { ...active, ...next, fallback: undefined, reading: undefined, uncut: read };
      for (const source of SOURCES) {
        // Not heard anew yet: the recogniser that lagged is told it caught up.
        if (before[source] !== active.said[source] && next.said[source] === before[source]) {
          active.onWords(source, before[source]);
        }
      }
    } else {
      next.remove();
      await native.cancel(next.session).catch(() => undefined);
    }
  } catch (error) {
    recordDictationError('start', error);
    if (current === active) {
      current = undefined;
      later(active.onLost);
    }
  }
};

/**
 * The phrase so far could not be read with the microphone open: it is
 * read the way a finished listening is (the microphone closes, the live
 * recognisers stop first), and the microphone opens again for what comes
 * next. Words said while it is closed go unheard. Once per session: a
 * read or a finish meanwhile waits for this one instead of finishing the
 * session again, and the phrase still comes back to a listening given up
 * meanwhile (a phrase on its way lands). Undefined when the module no
 * longer held the session.
 */
const readAfresh = (native: Native, active: Listening): Promise<SpeechRead | undefined> => {
  active.fallback ??= (async () => {
    let result: SpeechRead | null;
    try {
      result = await native.finish(active.session);
    } catch (error) {
      recordDictationError('finish', error);
      throw error;
    }
    const read = result === null ? undefined : after(active.uncut, result);
    await reopen(native, active, read);
    return read;
  })();
  return active.fallback;
};

/** A fallback reading as the phrase read: the new session holds nothing of it, so there is nothing to cut. */
const phraseIn = (read: SpeechRead | undefined): PhraseRead | undefined =>
  read === undefined ? undefined : { heard: heardIn(read), mark: 0 };

/**
 * Apple's on-device SpeechAnalyzer through the app's own module
 * (`modules/solunivo-speech`): the microphone streams into it, its
 * recognisers' words come back while a phrase is said, and the phrase
 * is read whole when it ends, the microphone left open (`read`) or closed
 * with it (`finish`). Audio never leaves the device and is
 * never written to a file. The module is loaded lazily: a binary built
 * before it (an OTA update on an older build) offers no dictation rather
 * than crashing at launch. What the module answers when it fails is kept
 * for Settings › Advanced › Diagnostics.
 */
export const appleSpeech: SpeechToText = {
  cancel: async () => {
    const active = current;
    current = undefined;
    if (!active) {
      return;
    }
    active.remove();
    const native = loadSpeechModule();
    if (native && active.reading && !active.fallback) {
      // A phrase is on its way and may still have to be read the fallback
      // way: ending the session as a finish does keeps its audio for that
      // (the microphone closes all the same), and nothing opens again.
      void readAfresh(native, active).catch(() => undefined);
      return;
    }
    await native?.cancel(active.session).catch(() => undefined);
  },
  cut: (mark) => {
    const active = current;
    if (active) {
      active.uncut = undefined;
      loadSpeechModule()?.cut(active.session, mark);
    }
  },
  finish: async () => {
    const active = current;
    current = undefined;
    const native = loadSpeechModule();
    if (!active || !native) {
      return undefined;
    }
    active.remove();
    if (active.fallback) {
      // Already being read: the phrase on its way is what was said.
      const read = await active.fallback;
      return read ? heardIn(read) : undefined;
    }
    try {
      const result = await native.finish(active.session);
      return result ? heardIn(after(active.uncut, result)) : undefined;
    } catch (error) {
      recordDictationError('finish', error);
      throw error;
    }
  },
  isPrepared: () => {
    const native = loadSpeechModule();
    if (!native) {
      return true;
    }
    const { locale, second } = languagesFor(native);
    return preparedFor === `${locale} ${second ?? ''}`;
  },
  isSupported: async () => loadSpeechModule() !== undefined,
  prepare: async () => {
    const native = loadSpeechModule();
    if (!native) {
      throw unsupported();
    }
    await prepareIn(native);
  },
  read: async () => {
    const active = current;
    const native = loadSpeechModule();
    if (!active || !native) {
      return undefined;
    }
    if (active.fallback) {
      return phraseIn(await active.fallback);
    }
    let result: Awaited<ReturnType<Native['read']>>;
    const reading = native.read(active.session);
    active.reading = reading;
    try {
      result = await reading;
    } catch (error) {
      // On the iPhone the reading beside the live recognisers can fail
      // where the Mac's does not: the phrase is still read and sent.
      recordDictationError('read', error);
      return phraseIn(await readAfresh(native, active));
    } finally {
      if (active.reading === reading) {
        active.reading = undefined;
      }
    }
    return result ? { heard: heardIn(after(active.uncut, result)), mark: result.mark } : undefined;
  },
  start: async ({ onLost, onWords, signal }) => {
    starts += 1;
    const epoch = starts;
    const native = loadSpeechModule();
    if (!native) {
      throw unsupported();
    }
    if (!(await native.requestMicrophone())) {
      throw new MicrophoneDeniedError({ message: 'Microphone access was declined.' });
    }
    const { locale, second } = languagesFor(native);
    if (preparedFor !== `${locale} ${second ?? ''}`) {
      await prepareIn(native);
    }
    if (signal?.aborted) {
      return undefined;
    }
    // Parakeet's names for this phrase, read meanwhile: the phrase is read
    // seconds later. Loaded on first use: it reaches the backend.
    void import('./parakeetRuntime.ts')
      .then(({ beforeListening }) => beforeListening())
      .catch(() => undefined);
    let opened: Awaited<ReturnType<typeof openSession>>;
    try {
      opened = await openSession(native, onWords, nothingSaid());
    } catch (error) {
      recordDictationError('start', error);
      throw error;
    }
    // Given up while the microphone was opening: this phrase only goes.
    // The current one may be a newer caller's.
    if (signal?.aborted) {
      opened.remove();
      await native.cancel(opened.session).catch(() => undefined);
      return undefined;
    }
    // The module dropped the phrase before when this one started.
    current?.remove();
    current = {
      epoch,
      onLost,
      onWords,
      remove: opened.remove,
      said: opened.said,
      session: opened.session,
    };
    return { sources: opened.sources };
  },
};
