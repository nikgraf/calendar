import { Data } from 'effect';
import type { WordsSource } from './phraseEnd.ts';

/** One recognised span of speech, with the other readings the recogniser weighed for it. */
export interface TranscriptSegment {
  readonly alternatives?: ReadonlyArray<string> | undefined;
  readonly text: string;
}

/** What a phrase was heard as, once it was read in full. */
export interface Heard {
  /**
   * The whole phrase as the recogniser of the user's other language wrote
   * it (German on an English device in Austria), when there is one: a name
   * said that language's way stands in it as itself. Never the phrase
   * that is sent: only the place lookup reads it (`otherLanguageReading`).
   */
  readonly other?: string | undefined;
  readonly segments: ReadonlyArray<TranscriptSegment>;
  readonly text: string;
}

/** A phrase listened to: the recognisers that listen (the quick one needs its own assets). */
export interface SpeechStart {
  readonly sources: ReadonlyArray<WordsSource>;
}

/**
 * A phrase read while listening goes on (`SpeechToText.read`): what it was
 * heard as (nothing when nothing was said), and where its audio ended,
 * for `cut` once it landed.
 */
export interface PhraseRead {
  readonly heard: Heard | undefined;
  readonly mark: number;
}

/** The device or locale cannot transcribe at all — stop offering it. */
export class SpeechUnsupportedError extends Data.TaggedError('SpeechUnsupportedError')<{
  readonly message: string;
}> {}

/** The user declined the microphone; typing still works. */
export class MicrophoneDeniedError extends Data.TaggedError('MicrophoneDeniedError')<{
  readonly message: string;
}> {}

/**
 * On-device speech-to-text, one listening at a time, the same shape on
 * both platforms (Apple's SpeechAnalyzer behind each: the iOS module, the
 * desktop helper). Listening streams the microphone into two recognisers
 * that write the words as they are said (`onWords`, everything each wrote
 * since the listening began); reading takes the phrase so far once more,
 * whole, with the recogniser the words were always read with, and returns
 * that, beside it the phrase as the user's other language reads it
 * (`Heard.other`). A listening holds a phrase after another: `read` leaves
 * the microphone open, `cut` lets go of a phrase that landed so that the
 * next reading begins after it, `finish` reads and closes. When a phrase
 * ends is the caller's to decide (`listenForPhrase`, from the words).
 */
export interface SpeechToText {
  /** Abandons the listening, keeping nothing of it. */
  readonly cancel: () => Promise<void>;
  /**
   * The phrase read up to `mark` landed: its audio goes, and the next
   * `read` or `finish` begins after it. Nothing once the listening ended.
   */
  readonly cut: (mark: number) => void;
  /**
   * Stops listening and reads the phrase (everything since the last
   * `cut`). Undefined when nothing was said. The audio is gone afterwards
   * either way.
   */
  readonly finish: () => Promise<Heard | undefined>;
  /**
   * Whether the languages dictation listens in now (Settings › Dictation)
   * are the ones last prepared: one picked since needs `prepare` again,
   * which may download it. Absent where the languages never change.
   */
  readonly isPrepared?: () => boolean;
  /**
   * Whether transcription is worth offering at all — the native module is
   * present. Deliberately not "ready to run": the platform reports
   * unavailable until the locale's assets are installed, and installing
   * them is what `prepare` does, so gating the UI on readiness would hide
   * dictation on a perfectly capable device that simply has not used it
   * yet.
   */
  readonly isSupported: () => Promise<boolean>;
  /**
   * Installs the locale's assets, throwing when the locale or the device
   * cannot support transcription at all. First call can take a moment, so
   * callers should show progress rather than appearing to hang.
   */
  readonly prepare: () => Promise<void>;
  /**
   * Reads the phrase so far (everything since the last `cut`) while the
   * microphone stays open: what is said meanwhile is recorded, and the
   * next reading takes it in too unless this one is `cut`. Undefined once
   * the listening ended (finished, cancelled or replaced).
   */
  readonly read: () => Promise<PhraseRead | undefined>;
  /**
   * Starts listening, asking for the microphone if needed. Throws
   * MicrophoneDeniedError when refused. `onWords` gets each recogniser's
   * words so far whenever they change; `onLost`, that the phrase is gone
   * (the recognisers went away with their process) and nothing will
   * finish it. Resolves with the recognisers that listen, or nothing when
   * given up.
   *
   * A call whose `signal` is aborted before it finishes stops whatever it
   * opened and resolves without becoming the current phrase. A caller
   * that gave up (the bar closed while the microphone was being granted)
   * must not cancel afterwards instead: by then the current phrase may
   * belong to a newer caller.
   */
  readonly start: (options: {
    readonly onLost?: (() => void) | undefined;
    readonly onWords: (source: WordsSource, text: string) => void;
    readonly signal?: AbortSignal | undefined;
  }) => Promise<SpeechStart | undefined>;
}

/**
 * Joins recognised segments into one phrase. Returns undefined for silence
 * so callers can stay quiet instead of parsing an empty string — a
 * recording with no speech should not open an empty editor.
 */
export const transcriptFromSegments = (
  segments: ReadonlyArray<TranscriptSegment>,
): string | undefined => {
  const text = segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ')
    // Recognisers can emit doubled spaces around segment joins.
    .replaceAll(/\s+/g, ' ')
    .trim();
  return text || undefined;
};

/** A finished phrase from the recogniser's segments; undefined for silence. */
export const heardFromSegments = (
  segments: ReadonlyArray<TranscriptSegment>,
  other?: string,
): Heard | undefined => {
  const text = transcriptFromSegments(segments);
  if (text === undefined) {
    return undefined;
  }
  return other === undefined || other.trim() === ''
    ? { segments, text }
    : { other, segments, text };
};
