import { PUBLISHED_MODEL, type SessionSink } from '@calendar/ai';
import { useSyncExternalStore } from 'react';
import type { SessionsState } from '../backend.ts';

/**
 * Keep Assistant Sessions as this window sees it (electron/assistantSessions.ts):
 * the switch and the count, followed over `onSessions`, and the sink the
 * editor's thread hands a finished thread to (`sessionSink`). Main keeps
 * the file and stamps the app's version; the renderer never holds the log.
 */

let state: SessionsState | undefined;
const listeners = new Set<() => void>();
let following = false;

const follow = () => {
  if (following) {
    return;
  }
  following = true;
  window.calendarBridge.onSessions((next) => {
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

/** The switch and the count; undefined until main has answered. */
export const useSessionsState = (): SessionsState | undefined =>
  useSyncExternalStore(subscribe, () => state);

/** The Assistant's model as the record names it: the fixture under e2e, else the release. */
const modelName = (fixture: boolean): string =>
  fixture ? 'fixture' : `solunivo-assistant-${PUBLISHED_MODEL.version}`;

/**
 * Where the editor's thread sends its record. `on` reads the last state
 * main told this window: the editor opens long after the window began
 * following. `fixture`: the Assistant runs on the fixture model.
 */
export const sessionSink = (fixture: boolean): SessionSink => {
  follow();
  return {
    // Main stamps the app's version (`sessions:keep`).
    about: () => ({ app: { platform: 'Mac', version: '' }, model: modelName(fixture) }),
    keep: (session) => {
      void window.calendarBridge.sessionsKeep(session).catch(() => undefined);
    },
    on: () => state?.on === true,
  };
};
