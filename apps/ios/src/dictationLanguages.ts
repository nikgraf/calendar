import { AUTOMATIC, readLanguage, readSecondLanguage } from '@calendar/ai';
import { File, Paths } from 'expo-file-system';

/**
 * Settings › Dictation › Language and Second Language: this iPhone's
 * choices alone, kept beside the app's other notes (`voice-processing.json`
 * is the other). Automatic until picked: the iPhone's language, and the
 * native side's rule for the second (`SpeechAssets.other`).
 */
interface Note {
  readonly language: string;
  readonly second: string;
}

const NONE: Note = { language: AUTOMATIC, second: AUTOMATIC };

const file = () => new File(Paths.document, 'dictation-languages.json');

let cached: Note | undefined;
const listeners = new Set<() => void>();

const read = (): Note => {
  try {
    const target = file();
    if (!target.exists) {
      return NONE;
    }
    const stored = JSON.parse(target.textSync()) as { language?: unknown; second?: unknown };
    return { language: readLanguage(stored.language), second: readSecondLanguage(stored.second) };
  } catch {
    return NONE;
  }
};

const note = (): Note => {
  cached ??= read();
  return cached;
};

const write = (next: Note) => {
  cached = next;
  try {
    const target = file();
    if (!target.exists) {
      target.create();
    }
    target.writeSync(JSON.stringify(next));
  } catch {
    // Kept for this launch even when the note cannot be written.
  }
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The language dictation listens in: `AUTOMATIC` (the iPhone's) or one picked. */
export const dictationLanguage = {
  get: (): string => note().language,
  set: (language: string) => write({ ...note(), language: readLanguage(language) }),
  subscribe,
};

/** The second language a phrase is read in for places: `AUTOMATIC`, `OFF` or one picked. */
export const secondLanguage = {
  get: (): string => note().second,
  set: (second: string) => write({ ...note(), second: readSecondLanguage(second) }),
  subscribe,
};
