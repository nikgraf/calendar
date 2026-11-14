/** What the ear heard: the phrase began, or it ended. */
export type PhraseEvent = 'end' | 'start';

/**
 * The two recognisers that listen side by side. `quick` writes a word
 * a fraction of a second after it is said but mishears more in noise;
 * `accurate` hears better and writes in bursts about a second apart.
 */
export type WordsSource = 'accurate' | 'quick';

export interface PhraseEndOptions {
  /**
   * How long the accurate recogniser's words must stand still before the
   * phrase ends, when it has heard more than the quick one.
   */
  readonly accuratePauseMs: number;
  /** How long the quick recogniser's words must stand still before the phrase ends. */
  readonly quickPauseMs: number;
}

/**
 * Measured on spoken phrases replayed at the microphone's pace through
 * both recognisers, in quiet, steady noise and a room of voices (the
 * recordings behind `phraseEnd.test.ts`): a phrase ends about 1.3 s
 * after its last word in a quiet room, at most 2.5 s in a loud one, and
 * a thinking pause shorter than the quick one never cuts it.
 */
export const PHRASE_END_DEFAULTS: PhraseEndOptions = {
  accuratePauseMs: 1200,
  quickPauseMs: 900,
};

export interface PhraseEnd {
  /**
   * The clock moved to `atMs` (any monotonic clock, the one `words` was
   * given): 'end' once, when the words have stood still long enough.
   */
  readonly check: (atMs: number) => 'end' | undefined;
  /** A first word was heard: a phrase worth reading. */
  readonly heard: () => boolean;
  /** The words so far, as one line to show while the phrase is spoken. */
  readonly text: () => string;
  /**
   * A recogniser's words so far (everything it has written for this
   * phrase, not just the newest part), at `atMs`. 'start' once, at the
   * first word either recogniser writes.
   */
  readonly words: (source: WordsSource, text: string, atMs: number) => 'start' | undefined;
}

/** A change of punctuation or case is not a new word. */
const wordsOf = (text: string): ReadonlyArray<string> =>
  text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

interface Heard {
  /** When the words last changed. */
  readonly at: number;
  readonly count: number;
  readonly key: string;
  readonly text: string;
}

/**
 * The end of a spoken phrase, decided by the words rather than the
 * loudness. A phrase ends when the quick recogniser has written nothing
 * new for a moment — unless the accurate one has heard more than it
 * (the quick one goes deaf in a loud room before the accurate one does),
 * in which case the accurate one's words decide. Loudness alone cannot
 * tell speech from a loud room: in a café the level never falls enough
 * for a pause to be heard, and the phrase never ended.
 */
export const createPhraseEnd = (overrides: Partial<PhraseEndOptions> = {}): PhraseEnd => {
  const options = { ...PHRASE_END_DEFAULTS, ...overrides };
  const heardBy: Partial<Record<WordsSource, Heard>> = {};
  let started = false;
  let ended = false;

  const words = (source: WordsSource, text: string, atMs: number) => {
    const list = wordsOf(text);
    const key = list.join(' ');
    const before = heardBy[source];
    if (ended || !key) {
      return undefined;
    }
    if (key !== before?.key) {
      heardBy[source] = { at: atMs, count: list.length, key, text: text.trim() };
    } else if (before) {
      // Same words, new punctuation: shown, but they did not move.
      heardBy[source] = { ...before, text: text.trim() };
    }
    if (started) {
      return undefined;
    }
    started = true;
    return 'start';
  };

  const check = (atMs: number) => {
    if (ended || !started) {
      return undefined;
    }
    const { accurate, quick } = heardBy;
    const quickQuiet = quick ? atMs - quick.at : Number.POSITIVE_INFINITY;
    const accurateQuiet = accurate ? atMs - accurate.at : Number.POSITIVE_INFINITY;
    // One word of difference is the two writing at different moments.
    const agree = (accurate?.count ?? 0) <= (quick?.count ?? 0) + 1;
    const done = agree
      ? quick !== undefined && quickQuiet >= options.quickPauseMs
      : quickQuiet >= options.quickPauseMs && accurateQuiet >= options.accuratePauseMs;
    if (!done) {
      return undefined;
    }
    ended = true;
    return 'end';
  };

  /**
   * The accurate words as far as they go, then the quick one's newer
   * words after them: the line grows word by word and settles on the
   * better reading a second later, without the words before jumping
   * between the two.
   */
  const text = () => {
    const accurate = heardBy.accurate?.text.split(/\s+/).filter(Boolean) ?? [];
    const quick = heardBy.quick?.text.split(/\s+/).filter(Boolean) ?? [];
    return [...accurate, ...quick.slice(accurate.length)].join(' ');
  };

  return { check, heard: () => started, text, words };
};

/** How often the listening ear asks whether the phrase ended. */
export const PHRASE_CHECK_MS = 50;

export interface PhraseListener {
  readonly heard: () => boolean;
  /** No more asking: the recording was sent, dropped or ended by hand. */
  readonly stop: () => void;
  readonly text: () => string;
  /** A recogniser's words so far, as they arrive. 'start' at the first word. */
  readonly words: (source: WordsSource, text: string) => 'start' | undefined;
}

/**
 * `createPhraseEnd` on the wall clock, for a recording under way: it
 * asks every `PHRASE_CHECK_MS` whether the phrase ended, and calls
 * `onEnd` once when it has. The clock lives here, not in the hook that
 * listens: React's rules keep clocks out of components.
 */
export const listenForPhrase = (
  onEnd: () => void,
  overrides: Partial<PhraseEndOptions> = {},
): PhraseListener => {
  const ear = createPhraseEnd(overrides);
  const timer = setInterval(() => {
    if (ear.check(Date.now()) === 'end') {
      clearInterval(timer);
      onEnd();
    }
  }, PHRASE_CHECK_MS);
  return {
    heard: ear.heard,
    stop: () => {
      clearInterval(timer);
    },
    text: ear.text,
    words: (source, text) => ear.words(source, text, Date.now()),
  };
};
