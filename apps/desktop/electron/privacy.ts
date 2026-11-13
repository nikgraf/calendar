import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';

/**
 * Screen-sharing privacy: content protection (macOS NSWindowSharingNone)
 * keeps the window out of screen shares and recordings while it stays
 * visible locally. Off (visible) until the user turns it on in Settings;
 * a 10-minute pause is runtime-only state so a restart fails closed back
 * to the persisted mode, and it ends on time across sleep (`settlePause`).
 */

export type PrivacyMode = 'hidden' | 'visible';
export type PrivacyChoice = PrivacyMode | 'pause10m';

export interface PrivacyState {
  readonly mode: PrivacyMode;
  /** Set while a 10-minute pause is active (epoch ms). */
  readonly visibleUntil?: number;
}

const PAUSE_MS = 10 * 60 * 1000;

/**
 * A running pause. It is over once either clock says ten minutes have
 * passed. The monotonic clock counts sleep (libuv reads
 * `mach_continuous_time`) and ignores the clock being set back. The wall
 * clock is the one Settings counts down on.
 */
interface Pause {
  /** `performance.now()` ms. */
  readonly endsAt: number;
  /** Epoch ms, what Settings counts down to. */
  readonly visibleUntil: number;
}

let settingsPath: string | null = null;
let mode: PrivacyMode = 'visible';
let pause: Pause | null = null;
let pauseTimer: NodeJS.Timeout | null = null;

/** Ms until the pause is over, by whichever clock gets there first. */
const pauseLeft = (running: Pause): number =>
  Math.min(running.visibleUntil - Date.now(), running.endsAt - performance.now());

/**
 * The running pause, or null. A pause found over ends here for every
 * window, so no read (a new window, the capture hint, Settings) says hidden
 * while a window still shows in captures.
 */
const activePause = (): Pause | null => {
  if (pause !== null && pauseLeft(pause) <= 0) {
    settlePause();
  }
  return pause;
};

/** Whether the windows are kept out of captures right now (hidden, not paused). */
export const isProtected = (): boolean => mode === 'hidden' && activePause() === null;

export const getPrivacyState = (): PrivacyState => {
  const active = activePause();
  return { mode, ...(active ? { visibleUntil: active.visibleUntil } : {}) };
};

const listeners = new Set<(state: PrivacyState) => void>();

/** Main-process subscribers (the settings file mirrors the mode); windows hear `privacy:changed`. */
export const subscribePrivacy = (listener: (state: PrivacyState) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const applyAndBroadcast = () => {
  const value = isProtected();
  const state = getPrivacyState();
  for (const window of BrowserWindow.getAllWindows()) {
    window.setContentProtection(value);
    window.webContents.send('privacy:changed', state);
  }
  for (const listener of listeners) {
    listener(state);
  }
};

const persist = () => {
  if (!settingsPath) {
    return;
  }
  try {
    // Temp file + rename: a crash mid-write must not leave a truncated
    // settings.json, which would read as the default and drop "hidden".
    const temp = `${settingsPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ screenPrivacy: mode }, null, 2)}\n`);
    renameSync(temp, settingsPath);
  } catch {
    // A failed write must not break the running state.
  }
};

/**
 * Ends the pause once it is over, or waits for the time it has left. Runs
 * from its timer, when the Mac wakes or the screen unlocks, and from any
 * read that finds the pause over (`activePause`). A timer that
 * came due during sleep fires only when Electron's main loop next polls,
 * and macOS does not count sleep against that poll's timeout. So after a
 * wake the timer waits for whatever else wakes the loop, and the windows
 * would stay capturable until then.
 */
const settlePause = () => {
  if (pauseTimer) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
  if (pause === null) {
    return;
  }
  const left = pauseLeft(pause);
  if (left > 0) {
    pauseTimer = setTimeout(settlePause, left);
    return;
  }
  pause = null;
  applyAndBroadcast();
};

export const setPrivacyChoice = (choice: PrivacyChoice): PrivacyState => {
  if (choice === 'pause10m' && mode === 'visible') {
    // Nothing is hidden to show: a pause would only start a countdown.
    return getPrivacyState();
  }
  if (choice === 'pause10m') {
    pause = { endsAt: performance.now() + PAUSE_MS, visibleUntil: Date.now() + PAUSE_MS };
  } else {
    pause = null;
    mode = choice;
    persist();
  }
  // Arms the new pause's timer, or clears the one a choice just ended.
  settlePause();
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
    if (parsed.screenPrivacy === 'hidden') {
      mode = 'hidden';
    }
  } catch {
    // Missing or invalid file → default 'visible'.
  }

  // powerMonitor is for a ready app, and initPrivacy runs before 'ready'.
  void app.whenReady().then(() => {
    powerMonitor.on('resume', settlePause);
    powerMonitor.on('unlock-screen', settlePause);
  });

  ipcMain.handle('privacy:get', () => getPrivacyState());
  ipcMain.handle('privacy:set', (_event, choice: unknown) =>
    choice === 'hidden' || choice === 'visible' || choice === 'pause10m'
      ? setPrivacyChoice(choice)
      : getPrivacyState(),
  );
};
