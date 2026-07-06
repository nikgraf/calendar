import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';

/**
 * Screen-sharing privacy: content protection (macOS NSWindowSharingNone)
 * keeps the window out of screen shares and recordings while it stays
 * visible locally. Hidden by default; a 10-minute pause is runtime-only
 * state so a restart fails closed back to the persisted mode.
 */

export type PrivacyMode = 'hidden' | 'visible';
export type PrivacyChoice = PrivacyMode | 'pause10m';

export interface PrivacyState {
  readonly mode: PrivacyMode;
  /** Set while a 10-minute pause is active (epoch ms). */
  readonly visibleUntil?: number;
}

const PAUSE_MS = 10 * 60 * 1000;

let settingsPath: string | null = null;
let mode: PrivacyMode = 'hidden';
let visibleUntil: number | null = null;
let pauseTimer: NodeJS.Timeout | null = null;

const isProtected = (): boolean =>
  mode === 'hidden' && (visibleUntil === null || Date.now() >= visibleUntil);

export const getPrivacyState = (): PrivacyState => ({
  mode,
  ...(visibleUntil !== null && Date.now() < visibleUntil ? { visibleUntil } : {}),
});

const applyAndBroadcast = () => {
  const value = isProtected();
  for (const window of BrowserWindow.getAllWindows()) {
    window.setContentProtection(value);
    window.webContents.send('privacy:changed', getPrivacyState());
  }
};

const persist = () => {
  if (!settingsPath) {
    return;
  }
  try {
    writeFileSync(settingsPath, `${JSON.stringify({ screenPrivacy: mode }, null, 2)}\n`);
  } catch {
    // A failed write must not break the running state.
  }
};

export const setPrivacyChoice = (choice: PrivacyChoice): PrivacyState => {
  if (pauseTimer) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
  if (choice === 'pause10m') {
    visibleUntil = Date.now() + PAUSE_MS;
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      visibleUntil = null;
      applyAndBroadcast();
    }, PAUSE_MS);
  } else {
    visibleUntil = null;
    mode = choice;
    persist();
  }
  applyAndBroadcast();
  return getPrivacyState();
};

/** Applies the current effective state to a newly created window. */
export const registerPrivacyWindow = (window: BrowserWindow): void => {
  window.setContentProtection(isProtected());
};

export const initPrivacy = (userDataDir: string): void => {
  settingsPath = join(userDataDir, 'settings.json');
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      screenPrivacy?: unknown;
    };
    if (parsed.screenPrivacy === 'visible') {
      mode = 'visible';
    }
  } catch {
    // Missing or invalid file → default 'hidden'.
  }

  ipcMain.handle('privacy:get', () => getPrivacyState());
  ipcMain.handle('privacy:set', (_event, choice: unknown) =>
    choice === 'hidden' || choice === 'visible' || choice === 'pause10m'
      ? setPrivacyChoice(choice)
      : getPrivacyState(),
  );
};
