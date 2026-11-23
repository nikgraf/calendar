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
 * microphone (`LaunchOptions.microphone`): a quiet room, then tones as
 * long as a phrase. The renderer streams it here as it would to the
 * helper, and each tone stands in for speech: while it plays, the next
 * of `phrases` is written word by word, as both recognisers' (everything
 * since the listening began, as theirs is); a reading answers the phrases
 * said since the last one that landed, joined, after `readMs` (the
 * helper's reading takes about a second). The renderer's own streaming
 * and the rule that ends a phrase on its words run on it. Nothing is
 * asked or installed. A phrase given as segments is read as them, the
 * other readings each weighed included, as the helper's final reading
 * answers.
 */
const fixture = (():
  | {
      readonly phrases: ReadonlyArray<ReadonlyArray<TranscriptSegment>>;
      readonly readMs: number;
    }
  | undefined => {
  const path = process.env['CALENDAR_MICROPHONE_FIXTURE'];
  if (process.env['CALENDAR_MICROPHONE'] !== 'fixture' || !path) {
    return undefined;
  }
  const given = JSON.parse(readFileSync(path, 'utf8')) as {
    readonly phrases: ReadonlyArray<
      string | { readonly segments: ReadonlyArray<TranscriptSegment> }
    >;
    readonly readMs?: number;
  };
  return {
    phrases: given.phrases.map((phrase) =>
      typeof phrase === 'string' ? [{ text: phrase }] : phrase.segments,
    ),
    readMs: given.readMs ?? 0,
  };
})();

export const microphoneFixture = fixture !== undefined;

/** The harness's tone plays at about -23 dBFS over a room at about -60. */
const TONE_DB = -40;
/**
 * The harness's tone in the renderer's 100 ms blocks (e2e/harness.ts,
 * `DICTATION_TONE_MS`): a phrase's words are spread over it.
 */
const TONE_BLOCKS = 12;

type Words = (source: WordsSource, text: string) => void;

/** The phrases taken so far, by every listening: the next one says the one after them. */
let landed = 0;
let listening:
  | {
      /** Where the next reading begins: the phrase after the last that landed. */
      base: number;
      /** The first phrase this listening said: its words begin there. */
      readonly first: number;
      readonly onWords: Words;
      /** The phrases said whole: the next tone says the one after them. */
      said: number;
      readonly session: number;
      /** Words of the phrase being said, shown so far. */
      shown: number;
      toneBlocks: number;
    }
  | undefined;

const wordsOf = (index: number): ReadonlyArray<string> =>
  (transcriptFromSegments(fixture?.phrases[index] ?? []) ?? '').split(' ').filter(Boolean);

/** Everything the listening said, up to `count` words of the phrase being said. */
const show = (active: NonNullable<typeof listening>, count: number) => {
  const words = Array.from({ length: active.said - active.first }, (_, index) =>
    wordsOf(active.first + index),
  ).flat();
  const text = [...words, ...wordsOf(active.said).slice(0, count)].join(' ');
  active.onWords('quick', text);
  active.onWords('accurate', text);
};

/** The phrases said from `from` to `to`, read as one. */
const readFrom = (from: number, to: number): ReadonlyArray<TranscriptSegment> =>
  (fixture?.phrases.slice(from, to) ?? []).flat();

export const fixtureListening = {
  /** One block of the page's microphone: 16 kHz mono Int16, little-endian. */
  audio: (session: number, pcm: Uint8Array) => {
    const current = listening;
    if (current?.session !== session || fixture?.phrases[current.said] === undefined) {
      return;
    }
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const samples = Array.from(
      { length: Math.floor(pcm.byteLength / 2) },
      (_, index) => view.getInt16(index * 2, true) / 32_768,
    );
    const level = levelOf(samples);
    const words = wordsOf(current.said);
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
        show(current, count);
      }
    } else if (current.toneBlocks > 0) {
      // The tone ended: the rest of the phrase, as a recogniser catches up.
      show(current, words.length);
      current.said += 1;
      current.shown = 0;
      current.toneBlocks = 0;
    }
  },
  cancel: (session: number) => {
    if (listening?.session === session) {
      listening = undefined;
    }
  },
  /** The phrase read up to `mark` landed: the next reading begins after it. */
  cut: (session: number, mark: number) => {
    if (listening?.session === session && mark > listening.base) {
      listening.base = Math.min(mark, listening.said);
      landed = listening.base;
    }
  },
  /**
   * The phrases said since the last one that landed, as the helper's
   * final reading answers; nothing for a listening that ended (as the
   * helper answers it).
   */
  finish: (session: number): { segments: ReadonlyArray<TranscriptSegment> } => {
    const active = listening;
    if (active?.session !== session) {
      return { segments: [] };
    }
    listening = undefined;
    landed = active.said;
    return { segments: readFrom(active.base, active.said) };
  },
  /** The phrases said since the last one that landed, listening on: what was said by now, answered after `readMs`. */
  read: async (
    session: number,
  ): Promise<{ mark?: number; segments: ReadonlyArray<TranscriptSegment> }> => {
    const active = listening;
    if (active?.session !== session) {
      return { segments: [] };
    }
    const mark = active.said;
    const segments = readFrom(active.base, mark);
    await new Promise((resolve) => setTimeout(resolve, fixture?.readMs ?? 0));
    return { mark, segments };
  },
  start: (session: number, onWords: Words) => {
    listening = {
      base: landed,
      first: landed,
      onWords,
      said: landed,
      session,
      shown: 0,
      toneBlocks: 0,
    };
  },
};
