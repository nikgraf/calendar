import { readFileSync } from 'node:fs';
import {
  levelOf,
  type TranscriptSegment,
  transcriptFromSegments,
  type WordsSource,
} from '@calendar/ai';

/**
 * CALENDAR_MICROPHONE=fixture: dictation without the Mac's speech
 * models. The e2e harness plays known audio into the page in place of the
 * microphone (`LaunchOptions.microphone`): a quiet room, then a tone as
 * long as a phrase. The renderer streams it here as it would to the
 * helper, and the tone stands in for speech: while it plays, the next
 * phrase's words come back one by one, as both recognisers'; once it
 * stops, the whole phrase. The renderer's own streaming and the rule that
 * ends a phrase on its words run on it. Nothing is asked or installed. A
 * phrase given as segments is read as them, the other readings each
 * weighed included, as the helper's final reading answers.
 */
const phrases = ((): ReadonlyArray<ReadonlyArray<TranscriptSegment>> | undefined => {
  const path = process.env['CALENDAR_MICROPHONE_FIXTURE'];
  if (process.env['CALENDAR_MICROPHONE'] !== 'fixture' || !path) {
    return undefined;
  }
  const given = (
    JSON.parse(readFileSync(path, 'utf8')) as {
      phrases: ReadonlyArray<string | { readonly segments: ReadonlyArray<TranscriptSegment> }>;
    }
  ).phrases;
  return given.map((phrase) => (typeof phrase === 'string' ? [{ text: phrase }] : phrase.segments));
})();

export const microphoneFixture = phrases !== undefined;

/** The harness's tone plays at about -23 dBFS over a room at about -60. */
const TONE_DB = -40;
/**
 * The harness's tone in the renderer's 100 ms blocks (e2e/harness.ts,
 * `DICTATION_LOOP_MS.phrase`): a phrase's words are spread over it.
 */
const TONE_BLOCKS = 12;

type Words = (source: WordsSource, text: string) => void;

let transcribed = 0;
let listening:
  | {
      readonly onWords: Words;
      readonly session: number;
      shown: number;
      toneBlocks: number;
    }
  | undefined;

const nextPhrase = (): ReadonlyArray<TranscriptSegment> | undefined => phrases?.[transcribed];

const show = (words: ReadonlyArray<string>, count: number, onWords: Words) => {
  const text = words.slice(0, count).join(' ');
  onWords('quick', text);
  onWords('accurate', text);
};

export const fixtureListening = {
  /** One block of the page's microphone: 16 kHz mono Int16, little-endian. */
  audio: (session: number, pcm: Uint8Array) => {
    const current = listening;
    const phrase = nextPhrase();
    if (current?.session !== session || phrase === undefined) {
      return;
    }
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const samples = Array.from(
      { length: Math.floor(pcm.byteLength / 2) },
      (_, index) => view.getInt16(index * 2, true) / 32_768,
    );
    const level = levelOf(samples);
    const words = (transcriptFromSegments(phrase) ?? '').split(' ');
    if (level > TONE_DB) {
      current.toneBlocks += 1;
      // Spread over the tone, the last word at its end: no gap between
      // words is as long as the pause that ends a phrase, so however
      // short the phrase, it never ends while the tone still plays.
      const count = Math.min(
        words.length - 1,
        Math.floor((current.toneBlocks * words.length) / TONE_BLOCKS),
      );
      if (count > current.shown) {
        current.shown = count;
        show(words, count, current.onWords);
      }
    } else if (current.toneBlocks > 0 && current.shown < words.length) {
      // The tone ended: the rest of the phrase, as a recogniser catches up.
      current.shown = words.length;
      show(words, words.length, current.onWords);
    }
  },
  cancel: (session: number) => {
    if (listening?.session === session) {
      listening = undefined;
    }
  },
  /**
   * The next phrase "heard", as the helper's final reading answers;
   * nothing once they run out, and nothing for a phrase no longer
   * listened to (as the helper answers it).
   */
  finish: (session: number): { segments: ReadonlyArray<TranscriptSegment> } => {
    if (listening?.session !== session) {
      return { segments: [] };
    }
    listening = undefined;
    const segments = nextPhrase();
    transcribed += 1;
    return { segments: segments ?? [] };
  },
  start: (session: number, onWords: Words) => {
    listening = { onWords, session, shown: 0, toneBlocks: 0 };
  },
};

/**
 * The languages the fixture's "recogniser" has, as the helper answers
 * `speech.languages`: Automatic's second language is German for any other
 * language, English for German.
 */
export const fixtureLanguages = (
  locale: string,
): { readonly automatic: string; readonly available: ReadonlyArray<string> } => ({
  automatic: locale.toLowerCase().startsWith('de') ? 'en-US' : 'de-AT',
  available: ['de-AT', 'de-DE', 'en-GB', 'en-US', 'fr-FR'],
});
