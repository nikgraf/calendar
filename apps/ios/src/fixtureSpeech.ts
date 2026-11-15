import { heardFromSegments, type SpeechToText, type TranscriptSegment } from '@calendar/ai';

/**
 * What the fixture hears, phrase by phrase: the words as they are said
 * (shown while listening), and the phrase as read once it ends — in the
 * fixture model's grammar, so the Assistant answers it — in segments, as
 * the recogniser reads one. The first names a place the way dictation
 * misheard "Figlmüller" (macOS 27.2, 2026-11-15), with the other readings
 * it weighed: MapKit finds the place for one of them.
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
];
/** The room before the first word. */
const LEAD_MS = 600;
/** A word about this often, as the quick recogniser writes them. */
const WORD_MS = 250;

let turn = 0;
let listening = false;
let timers: Array<ReturnType<typeof setTimeout>> = [];

const clear = () => {
  for (const timer of timers) {
    clearTimeout(timer);
  }
  timers = [];
};

/**
 * EXPO_PUBLIC_CALENDAR_SPEECH=fixture: dictation on a simulator, which has
 * no speech assets. Each start "says" the script's next phrase a word at a
 * time — the quick recogniser's every word, the accurate one's every
 * third — and then nothing, so the app's own rule ends the phrase; finish
 * answers it as read. Once the script runs out, nothing more is said.
 */
export const fixtureSpeech: SpeechToText = {
  cancel: async () => {
    clear();
    listening = false;
  },
  finish: async () => {
    clear();
    if (!listening) {
      return undefined;
    }
    listening = false;
    const line = SCRIPT[turn];
    turn += 1;
    return line ? heardFromSegments(line.heard) : undefined;
  },
  isSupported: async () => true,
  prepare: async () => undefined,
  start: async ({ onWords, signal }) => {
    clear();
    if (signal?.aborted) {
      return undefined;
    }
    listening = true;
    const words = SCRIPT[turn]?.said.split(' ') ?? [];
    for (const [index] of words.entries()) {
      timers.push(
        setTimeout(
          () => {
            const text = words.slice(0, index + 1).join(' ');
            onWords('quick', text);
            if (index % 3 === 2 || index === words.length - 1) {
              onWords('accurate', text);
            }
          },
          LEAD_MS + index * WORD_MS,
        ),
      );
    }
    return { sources: ['accurate', 'quick'] };
  },
};
