import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendSession, type AssistantSession, sessionCount } from '@calendar/ai';

/**
 * The Mac's Assistant session log (`sessionLog.ts` in `@calendar/ai`) as
 * files under the profile: the switch in `assistant-sessions.json`, the
 * sessions as lines of `assistant-sessions.jsonl`, at most the cap, the
 * oldest dropped. Off unless switched on; nothing here is sent anywhere.
 * No Electron: `assistantSessions.ts` puts it behind IPC.
 */

export interface SessionsState {
  readonly count: number;
  readonly on: boolean;
}

export interface SessionsFile {
  readonly delete: () => SessionsState;
  readonly keep: (session: AssistantSession) => SessionsState;
  /** The log's text, '' when there is none. */
  readonly read: () => string;
  readonly setOn: (on: boolean) => SessionsState;
  readonly state: () => SessionsState;
}

const writeAtomic = (path: string, text: string): void => {
  const temp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
};

export const sessionsFile = (userDataDir: string): SessionsFile => {
  const choice = join(userDataDir, 'assistant-sessions.json');
  const log = join(userDataDir, 'assistant-sessions.jsonl');
  const read = (): string => {
    try {
      return readFileSync(log, 'utf8');
    } catch {
      return '';
    }
  };
  const isOn = (): boolean => {
    try {
      return (JSON.parse(readFileSync(choice, 'utf8')) as { on?: unknown }).on === true;
    } catch {
      return false;
    }
  };
  const state = (): SessionsState => ({ count: sessionCount(read()), on: isOn() });
  return {
    delete: () => {
      rmSync(log, { force: true });
      return state();
    },
    keep: (session) => {
      // Switched off while the editor was open: the thread is not kept.
      if (isOn()) {
        mkdirSync(userDataDir, { recursive: true });
        writeAtomic(log, appendSession(read(), session));
      }
      return state();
    },
    read,
    setOn: (on) => {
      mkdirSync(userDataDir, { recursive: true });
      writeAtomic(choice, JSON.stringify({ on }));
      return state();
    },
    state: () => (existsSync(userDataDir) ? state() : { count: 0, on: false }),
  };
};
