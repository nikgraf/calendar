import type { ParakeetState } from '@calendar/ai';
import { Effect } from 'effect';
import { useSyncExternalStore } from 'react';
import { backend } from '../backend.ts';

/**
 * Parakeet as this window sees it (electron/parakeetModel.ts): where it
 * stands, followed over `onParakeet`, and the names it listens for, handed
 * to it as a phrase starts (`beforeListening`, from desktopSpeech.ts).
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
 * As a phrase starts: the names to listen for (read by the backend at most
 * every five minutes), handed to main, which tells the helper whether to
 * read with Parakeet. Also how a helper that started again hears it.
 */
export const beforeListening = async (): Promise<void> => {
  const names = await Effect.runPromise(backend.dictationVocabulary()).catch(() => undefined);
  // Unread, the names handed on last stay in place.
  if (names !== undefined) {
    await window.calendarBridge
      .parakeetVocabulary([...names.people, ...names.places])
      .catch(() => undefined);
  }
};
