import {
  appendSession,
  assistantModelManifest,
  type AssistantSession,
  sessionCount,
  type SessionSink,
} from '@calendar/ai';
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { modelFixture } from './model.ts';

/**
 * Keep Assistant Sessions on the iPhone (Settings › Advanced ›
 * Diagnostics): the switch in `assistant-sessions.json`, the sessions as
 * lines of `assistant-sessions.jsonl` under Documents, at most the cap,
 * the oldest dropped (`sessionLog.ts` in `@calendar/ai`). Off unless
 * switched on; nothing here is sent anywhere — Export hands the file to
 * the share sheet. Read and written synchronously, as the app's other
 * notes are: one write when an editor closes.
 */

const choiceFile = () => new File(Paths.document, 'assistant-sessions.json');
const logFile = () => new File(Paths.document, 'assistant-sessions.jsonl');

export interface SessionsState {
  readonly count: number;
  readonly on: boolean;
}

const readLog = (): string => {
  try {
    const target = logFile();
    return target.exists ? target.textSync() : '';
  } catch {
    return '';
  }
};

const readOn = (): boolean => {
  try {
    const target = choiceFile();
    return target.exists && (JSON.parse(target.textSync()) as { on?: unknown }).on === true;
  } catch {
    return false;
  }
};

const write = (target: File, text: string): void => {
  if (!target.exists) {
    target.create();
  }
  target.writeSync(text);
};

let cached: SessionsState | undefined;
const listeners = new Set<() => void>();

const changed = (next: SessionsState) => {
  cached = next;
  for (const listener of listeners) {
    listener();
  }
};

export const assistantSessions = {
  delete: (): void => {
    try {
      const target = logFile();
      if (target.exists) {
        target.delete();
      }
    } catch {
      // Gone or not, the count says what is left.
    }
    changed({ count: sessionCount(readLog()), on: assistantSessions.get().on });
  },
  /** The log's file, for the share sheet; none when nothing is kept. */
  file: (): File | undefined => {
    const target = logFile();
    return target.exists ? target : undefined;
  },
  get: (): SessionsState => {
    cached ??= { count: sessionCount(readLog()), on: readOn() };
    return cached;
  },
  keep: (session: AssistantSession): void => {
    if (!assistantSessions.get().on) {
      return;
    }
    try {
      const text = appendSession(readLog(), session);
      write(logFile(), text);
      changed({ count: sessionCount(text), on: true });
    } catch {
      // A thread that cannot be written is not kept; the app goes on.
    }
  },
  setOn: (on: boolean): void => {
    try {
      write(choiceFile(), JSON.stringify({ on }));
    } catch {
      // Kept for this launch.
    }
    changed({ count: assistantSessions.get().count, on });
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** The app as a record names it: its version and the build it is. */
const appVersion = (): string => {
  const version = Constants.expoConfig?.version ?? '';
  const build = Constants.platform?.ios?.buildNumber;
  return build ? `${version} (${build})` : version;
};

/** Where the editor's thread sends its record: this file, while the switch is on. */
export const sessionSink: SessionSink = {
  about: () => ({
    app: { platform: 'iPhone', version: appVersion() },
    model: modelFixture
      ? 'fixture'
      : `solunivo-assistant-${assistantModelManifest(process.env['EXPO_PUBLIC_ASSISTANT_MODEL']).version}`,
  }),
  keep: (session) => assistantSessions.keep(session),
  on: () => assistantSessions.get().on,
};
