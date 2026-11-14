import { readFileSync } from 'node:fs';
import { levelOf, type WordsSource } from '@calendar/ai';

/**
 * CALENDAR_MICROPHONE=fixture: dictation without the Mac's speech
 * models. The e2e harness plays known audio into the page in place of the
 * microphone (`LaunchOptions.microphone`): a quiet room, then a tone as
 * long as a phrase. The renderer streams it here as it would to the
 * helper, and the tone stands in for speech: while it plays, the next
 * phrase's words come back one by one, as both recognisers'; once it
 * stops, the whole phrase. The renderer's own streaming and the rule that
 * ends a phrase on its words run on it. Nothing is asked or installed.
 */
const phrases = ((): ReadonlyArray<string> | undefined => {
  const path = process.env['CALENDAR_MICROPHONE_FIXTURE'];
  if (process.env['CALENDAR_MICROPHONE'] !== 'fixture' || !path) {
    return undefined;
  }
  return (JSON.parse(readFileSync(path, 'utf8')) as { phrases: ReadonlyArray<string> }).phrases;
})();

export const microphoneFixture = phrases !== undefined;

/** The harness's tone plays at about -23 dBFS over a room at about -60. */
const TONE_DB = -40;
/** Blocks of tone per word written: a word about every 200 ms. */
const BLOCKS_PER_WORD = 2;

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

const nextPhrase = (): string | undefined => phrases?.[transcribed];

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
    const words = phrase.split(' ');
    if (level > TONE_DB) {
      current.toneBlocks += 1;
      const count = Math.min(words.length, Math.ceil(current.toneBlocks / BLOCKS_PER_WORD));
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
  /** The next phrase "heard", as the helper's final reading answers; nothing once they run out. */
  finish: (session: number): { segments: ReadonlyArray<{ text: string }> } => {
    if (listening?.session === session) {
      listening = undefined;
    }
    const text = nextPhrase();
    transcribed += 1;
    return { segments: text === undefined ? [] : [{ text }] };
  },
  start: (session: number, onWords: Words) => {
    listening = { onWords, session, shown: 0, toneBlocks: 0 };
  },
};
