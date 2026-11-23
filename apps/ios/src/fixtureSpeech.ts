import { heardFromSegments, type SpeechToText, type TranscriptSegment } from '@calendar/ai';

/**
 * What the fixture hears, phrase by phrase: the words as they are said
 * (shown while listening), and the phrase as read once it ends — in the
 * fixture model's grammar, so the Assistant answers it — in segments, as
 * the recogniser reads one. The first names a place the way dictation
 * misheard "Figlmüller" (macOS 27.2, 2026-11-15), with the other readings
 * it weighed: MapKit finds the place for one of them. The last changes
 * nothing, and one of its other readings would.
 */
const SCRIPT: ReadonlyArray<{
  readonly heard: ReadonlyArray<TranscriptSegment>;
  readonly said: string;
}> = [
  {
    heard: [
      { text: 'Lunch with Sarah | +1 | 13:00-14:00 |' },
      {
        alternatives: [' Figelmiller', ' Feigelmiller', ' Figelmuller', ' Figlemiller'],
        text: ' Figelmiller',
      },
    ],
    said: 'Lunch with Sarah tomorrow at one at Figlmüller',
  },
  { heard: [{ text: '| | 14:00-15:00' }], said: 'Make it two instead' },
  // "Invite Tom", misheard: nothing changes, and the Assistant offers
  // the reading that would.
  {
    heard: [
      { alternatives: ['In white', 'Invite', 'In wide'], text: 'In white' },
      { text: ' Tom' },
    ],
    said: 'In white Tom',
  },
];
/** The room before the first word. */
const LEAD_MS = 600;
/** A word about this often, as the quick recogniser writes them. */
const WORD_MS = 250;
/** The pause after a phrase before the next one: long enough for it to be read and land. */
const BETWEEN_MS = 4000;

/** The script's phrases taken so far: the next listening says the one after them. */
let turn = 0;
/**
 * The listening: the phrase its next reading begins with, and how many of
 * the script's phrases it has said whole.
 */
let listening: { base: number; said: number } | undefined;
let timers: Array<ReturnType<typeof setTimeout>> = [];

const clear = () => {
  for (const timer of timers) {
    clearTimeout(timer);
  }
  timers = [];
};

/** The phrases said since `from`, read as one. */
const readFrom = (from: number, to: number) =>
  heardFromSegments(SCRIPT.slice(from, to).flatMap((line) => line.heard));

/**
 * EXPO_PUBLIC_CALENDAR_SPEECH=fixture: dictation on a simulator, which has
 * no speech assets. A listening "says" the script's phrases one after
 * another, a word at a time — the quick recogniser's every word, the
 * accurate one's every third, everything since the listening began, as
 * the recognisers write it — with a pause after each, so the app's own
 * rule ends the phrase; a reading answers the phrases said since the last
 * cut, as read. Once the script runs out, nothing more is said.
 */
export const fixtureSpeech: SpeechToText = {
  cancel: async () => {
    clear();
    listening = undefined;
  },
  cut: (mark) => {
    if (listening && mark > listening.base) {
      listening.base = mark;
      turn = mark;
    }
  },
  finish: async () => {
    clear();
    const active = listening;
    listening = undefined;
    if (!active) {
      return undefined;
    }
    turn = active.said;
    return readFrom(active.base, active.said);
  },
  isSupported: async () => true,
  prepare: async () => undefined,
  read: async () =>
    listening
      ? { heard: readFrom(listening.base, listening.said), mark: listening.said }
      : undefined,
  start: async ({ onWords, signal }) => {
    clear();
    if (signal?.aborted) {
      return undefined;
    }
    const active = { base: turn, said: turn };
    listening = active;
    const words: Array<string> = [];
    let at = LEAD_MS;
    for (const [index, line] of SCRIPT.slice(turn).entries()) {
      const lineWords = line.said.split(' ');
      for (const [position, word] of lineWords.entries()) {
        words.push(word);
        const count = words.length;
        const last = position === lineWords.length - 1;
        timers.push(
          setTimeout(() => {
            const text = words.slice(0, count).join(' ');
            onWords('quick', text);
            if (count % 3 === 0 || last) {
              onWords('accurate', text);
            }
          }, at),
        );
        at += WORD_MS;
      }
      const phrase = turn + index + 1;
      timers.push(
        setTimeout(() => {
          active.said = phrase;
        }, at - WORD_MS),
      );
      at += BETWEEN_MS;
    }
    return { sources: ['accurate', 'quick'] };
  },
};
