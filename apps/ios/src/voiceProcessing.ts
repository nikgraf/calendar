import { File, Paths } from 'expo-file-system';

/**
 * Settings › Advanced › Voice Processing: whether dictation records through
 * the iPhone's own echo cancellation and noise suppression. Off unless
 * turned on: nothing measured yet says whether it helps the recognisers or
 * hurts them, so this is the switch to compare the two with in a loud room.
 * This iPhone's choice alone, kept beside the app's other notes.
 */
const file = () => new File(Paths.document, 'voice-processing.json');

let cached: boolean | undefined;
const listeners = new Set<() => void>();

const read = (): boolean => {
  try {
    const target = file();
    return target.exists && (JSON.parse(target.textSync()) as { on?: unknown }).on === true;
  } catch {
    return false;
  }
};

export const voiceProcessing = {
  get: (): boolean => {
    cached ??= read();
    return cached;
  },
  set: (on: boolean) => {
    cached = on;
    try {
      const target = file();
      if (!target.exists) {
        target.create();
      }
      target.write(JSON.stringify({ on }));
    } catch {
      // Kept for this launch even when the note cannot be written.
    }
    for (const listener of listeners) {
      listener();
    }
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
