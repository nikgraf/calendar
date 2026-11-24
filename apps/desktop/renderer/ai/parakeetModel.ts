import type { ParakeetState } from '@calendar/ai';
import { useSyncExternalStore } from 'react';

/**
 * Parakeet as this window sees it (electron/parakeetModel.ts): where it
 * stands, followed over `onParakeet`, and the start of a phrase, which
 * main answers with the names to listen for (`beforeListening`, from
 * desktopSpeech.ts).
 */

let state: ParakeetState | undefined;
const listeners = new Set<() => void>();
let following = false;

const follow = () => {
  if (following) {
    return;
  }
  following = true;
  window.calendarBridge.onParakeet((next) => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  });
};

const subscribe = (listener: () => void) => {
  follow();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Where Parakeet stands; undefined until main has answered. */
export const useParakeetState = (): ParakeetState | undefined =>
  useSyncExternalStore(subscribe, () => state);

/**
 * As a phrase starts: main reads the names to listen for from the backend
 * it hosts and hands them to Parakeet, loading it meanwhile. Also how a
 * helper that started again hears it.
 */
export const beforeListening = async (): Promise<void> => {
  await window.calendarBridge.parakeetVocabulary().catch(() => undefined);
};
