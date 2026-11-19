import { File, Paths } from 'expo-file-system';

/**
 * Settings › Dictation › Reduce Background Noise: whether dictation records
 * through the iPhone's voice processing (echo cancellation, noise
 * suppression, gain), which also lets iOS offer its Mic Mode (Voice
 * Isolation) for the app. On unless turned off, as the Mac's microphone
 * is. This iPhone's choice alone, kept beside the app's other notes; a
 * choice is always written out, so an "off" stays off whatever the default.
 */
const file = () => new File(Paths.document, 'voice-processing.json');

let cached: boolean | undefined;
const listeners = new Set<() => void>();

const read = (): boolean => {
  try {
    const target = file();
    return !target.exists || (JSON.parse(target.textSync()) as { on?: unknown }).on !== false;
  } catch {
    return true;
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
      target.writeSync(JSON.stringify({ on }));
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
