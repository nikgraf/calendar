import { Data } from 'effect';
import type { WordsSource } from './phraseEnd.ts';

/** One recognised span of speech, with the other readings the recogniser weighed for it. */
export interface TranscriptSegment {
  readonly alternatives?: ReadonlyArray<string> | undefined;
  readonly text: string;
}

/** What a phrase was heard as, once it was read in full. */
export interface Heard {
  readonly segments: ReadonlyArray<TranscriptSegment>;
  readonly text: string;
}

/** A phrase listened to: the recognisers that listen (the quick one needs its own assets). */
export interface SpeechStart {
  readonly sources: ReadonlyArray<WordsSource>;
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
 * On-device speech-to-text, one phrase at a time, the same shape on both
 * platforms (Apple's SpeechAnalyzer behind each: the iOS module, the
 * desktop helper). Listening streams the microphone into two recognisers
 * that write the words as they are said (`onWords`); finishing reads the
 * whole phrase once more, with the recogniser the words were always read
 * with, and returns that. When the phrase ends is the caller's to decide
 * (`listenForPhrase`, from the words).
 */
export interface SpeechToText {
  /** Abandons the phrase being listened to, keeping nothing of it. */
  readonly cancel: () => Promise<void>;
  /**
   * Stops listening and reads the phrase. Undefined when nothing was
   * said. The audio is gone afterwards either way.
   */
  readonly finish: () => Promise<Heard | undefined>;
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
   * Starts listening, asking for the microphone if needed. Throws
   * MicrophoneDeniedError when refused. `onWords` gets each recogniser's
   * words so far whenever they change. Resolves with the recognisers
   * that listen, or nothing when given up.
   *
   * A call whose `signal` is aborted before it finishes stops whatever it
   * opened and resolves without becoming the current phrase. A caller
   * that gave up (the bar closed while the microphone was being granted)
   * must not cancel afterwards instead: by then the current phrase may
   * belong to a newer caller.
   */
  readonly start: (options: {
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
): Heard | undefined => {
  const text = transcriptFromSegments(segments);
  return text === undefined ? undefined : { segments, text };
};
