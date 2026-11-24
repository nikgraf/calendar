import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createParakeetStore,
  type ParakeetChoice,
  type ParakeetPort,
  type ParakeetStore,
  readParakeetChoice,
} from '@calendar/ai';
import { BrowserWindow, ipcMain } from 'electron';
import { callHelper, helperAvailable, onHelperEvent } from './helperProcess.ts';

/**
 * Parakeet on the Mac (`createParakeetStore`, shared with the iPhone): its
 * files under the profile's `parakeet/` folder, kept by the helper
 * (`parakeet.*`, ParakeetBridge.swift), the switch and the download asked
 * for in `parakeet.json` beside them. Dictation in the helper reads each
 * phrase with it once it is here and the switch is on; the renderer hands
 * it the names to listen for as a phrase starts (`parakeet:vocabulary`).
 *
 * Switches: CALENDAR_PARAKEET=off leaves it out (the e2e harness: nothing
 * fetched, nothing loaded); CALENDAR_PARAKEET=fixture keeps it in memory,
 * with a download that is done at once and nothing loaded (the specs of
 * Settings › Dictation and the Create lesson).
 */
const SWITCH = process.env['CALENDAR_PARAKEET'];

const fixturePort = (): ParakeetPort => {
  let here = false;
  let choice: ParakeetChoice | undefined;
  return {
    cancel: () => undefined,
    download: async (onProgress) => {
      onProgress(1);
      here = true;
    },
    files: async () => ({ bytes: here ? 712_000_000 : 0, here }),
    readChoice: async () => choice,
    remove: async () => {
      here = false;
    },
    use: async () => undefined,
    writeChoice: async (next) => {
      choice = next;
    },
  };
};

const helperPort = (userDataDir: string): ParakeetPort => {
  const folder = join(userDataDir, 'parakeet');
  const choiceFile = join(userDataDir, 'parakeet.json');
  const call = (method: string, params: Record<string, unknown> = {}) =>
    callHelper(method, { folder, ...params });
  return {
    cancel: () => {
      call('parakeet.cancel').catch(() => undefined);
    },
    download: async (onProgress) => {
      const off = onHelperEvent('parakeet.progress', (body) => {
        const fraction = (body as { fraction?: unknown }).fraction;
        if (typeof fraction === 'number') {
          onProgress(fraction);
        }
      });
      try {
        await call('parakeet.download');
      } finally {
        off();
      }
    },
    files: async () => {
      const found = (await call('parakeet.state')) as { bytes?: unknown; here?: unknown };
      return {
        bytes: typeof found.bytes === 'number' ? found.bytes : 0,
        here: found.here === true,
      };
    },
    prepare: async () => {
      await call('parakeet.prepare');
    },
    readChoice: async () => {
      try {
        return readParakeetChoice(JSON.parse(readFileSync(choiceFile, 'utf8')));
      } catch {
        return undefined;
      }
    },
    remove: async () => {
      await call('parakeet.remove');
    },
    use: async (on, vocabulary) => {
      await call('parakeet.use', { on, vocabulary });
    },
    writeChoice: async (choice) => {
      mkdirSync(userDataDir, { recursive: true });
      writeFileSync(choiceFile, JSON.stringify(choice));
    },
  };
};

const storeOf = (userDataDir: string): ParakeetStore => {
  if (SWITCH === 'off') {
    return createParakeetStore({ reason: 'off', supported: false });
  }
  if (SWITCH === 'fixture') {
    return createParakeetStore({ port: fixturePort(), supported: true });
  }
  return helperAvailable()
    ? createParakeetStore({ port: helperPort(userDataDir), supported: true })
    : createParakeetStore({ reason: 'module', supported: false });
};

const isNetwork = (value: unknown): value is 'any' | 'wifi' => value === 'any' || value === 'wifi';
const isTerms = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) &&
  value.length <= 500 &&
  value.every((term) => typeof term === 'string' && term.length <= 200);

export const registerParakeetModel = (userDataDir: string): void => {
  const store = storeOf(userDataDir);
  store.subscribe(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('parakeet:changed', store.getState());
    }
  });
  // A helper that started again holds no model until told: each phrase's
  // names (`parakeet:vocabulary`) tell it again whether to read with it.
  void store.boot();

  ipcMain.handle('parakeet:state', () => store.getState());
  ipcMain.handle('parakeet:download', (_event, network: unknown) => {
    void store.download(isNetwork(network) ? network : 'any');
  });
  ipcMain.handle('parakeet:retry', () => {
    void store.retry();
  });
  ipcMain.handle('parakeet:remove', () => store.remove());
  ipcMain.handle('parakeet:set-on', (_event, on: unknown) => {
    if (typeof on === 'boolean') {
      return store.setOn(on);
    }
    return undefined;
  });
  ipcMain.handle('parakeet:vocabulary', (_event, terms: unknown) =>
    isTerms(terms) ? store.vocabulary(terms) : undefined,
  );
};
