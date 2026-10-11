import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { callHelper, helperAvailable, onHelperEvent, onHelperExit } from './helperProcess.ts';
import { isProtected, subscribePrivacy } from './privacy.ts';

/**
 * Screen privacy keeps the windows out of captures, and a screenshot then
 * shows whatever was behind them — noticed only afterwards. macOS tells an
 * app nothing when a capture starts, so the helper watches for the system
 * screenshot tool's process (`capture.watch`), and while a capture runs
 * every window hears `privacy:capture` and shows that it is left out — a
 * window opened mid-capture asks `privacy:capture-state` first. The hint
 * is drawn inside the protected window, so no capture ever holds it.
 *
 * The watch runs only while it can matter: privacy on and a window on
 * screen. CALENDAR_CAPTURE_WATCH=off (the e2e default) never starts it;
 * `fixture` reads a marker file in userData instead of the helper, so a
 * spec can start and end a capture without taking a screenshot.
 */

/** A source of "a capture is under way", started and stopped on demand. */
interface CaptureSource {
  readonly set: (on: boolean) => void;
}

/** How often the fixture checks its marker file. */
const FIXTURE_POLL_MS = 100;
/** A helper that exited is asked again once its restart backoff has passed. */
const REWATCH_AFTER_EXIT_MS = 6000;

/** The marker file whose presence means "capturing" under CALENDAR_CAPTURE_WATCH=fixture. */
export const captureFixturePath = (userDataDir: string): string =>
  join(userDataDir, 'capture-active');

let watching = false;
let capturing = false;
let source: CaptureSource | null = null;

const broadcast = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('privacy:capture', capturing);
  }
};

const captured = (active: boolean) => {
  // A capture is only worth a hint while the windows are left out of it.
  const next = active && isProtected();
  if (next !== capturing) {
    capturing = next;
    broadcast();
  }
};

const hasWindowOnScreen = () =>
  BrowserWindow.getAllWindows().some((window) => window.isVisible() && !window.isMinimized());

const update = () => {
  const wanted = source !== null && isProtected() && hasWindowOnScreen();
  if (!wanted) {
    captured(false);
  }
  if (wanted !== watching) {
    watching = wanted;
    source?.set(wanted);
  }
};

const helperSource = (): CaptureSource => {
  onHelperEvent('capture.started', () => captured(true));
  onHelperEvent('capture.ended', () => captured(false));
  onHelperExit(() => {
    // The watch died with the process: forget it, and ask a fresh helper.
    if (watching) {
      watching = false;
      captured(false);
      setTimeout(update, REWATCH_AFTER_EXIT_MS);
    }
  });
  return {
    set: (on) => {
      callHelper('capture.watch', { on }).catch(() => {
        // An unanswered watch is a missing hint, never a broken app; the
        // next privacy or window change asks again.
        if (on) {
          watching = false;
        }
      });
    },
  };
};

const fixtureSource = (path: string): CaptureSource => {
  let timer: NodeJS.Timeout | null = null;
  return {
    set: (on) => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (on) {
        timer = setInterval(() => captured(existsSync(path)), FIXTURE_POLL_MS);
      } else {
        captured(false);
      }
    },
  };
};

/** Wire once from main, before any window exists. */
export const startCaptureHint = (userDataDir: string): void => {
  // Answered with or without a source: a page asks on every subscribe.
  ipcMain.handle('privacy:capture-state', () => capturing);
  const mode = process.env['CALENDAR_CAPTURE_WATCH'];
  source =
    mode === 'off'
      ? null
      : mode === 'fixture'
        ? fixtureSource(captureFixturePath(userDataDir))
        : helperAvailable()
          ? helperSource()
          : null;
  if (!source) {
    return;
  }
  subscribePrivacy(update);
  app.on('browser-window-created', (_event, window) => {
    // 'show' alone misses a window shown inactive (the e2e harness's), and
    // this handler runs before the one in windows.ts that shows it.
    window.once('ready-to-show', () => setImmediate(update));
    window.on('show', update);
    window.on('hide', update);
    window.on('minimize', update);
    window.on('restore', update);
    // After 'closed' the window has left getAllWindows().
    window.on('closed', () => setImmediate(update));
  });
};
