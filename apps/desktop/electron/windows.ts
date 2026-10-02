import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { registerPrivacyWindow } from './privacy.ts';

/**
 * The app's two windows. The main window is creatable at any time: the app
 * keeps running without a window on macOS (sync, reminders, the agent
 * gateway), so anything that needs the user's eyes — a Dock click, a
 * notification, an agent asking for approval — opens one on demand.
 * Settings is its own window (App menu › Settings…, ⌘,), one at most, and
 * opens whether or not a main window exists.
 */

const rootPath = fileURLToPath(new URL('..', import.meta.url));
export const rendererUrl = process.env.ELECTRON_RENDERER_URL;
/** Where the renderer is allowed to be: the vite dev server, or the built index. */
export const rendererOrigin = rendererUrl ?? pathToFileURL(join(rootPath, 'dist')).href;

/**
 * Whether a URL is this app's own page. Compared by origin (dev server)
 * or by the built folder with its trailing slash — a bare prefix test
 * would also accept `…/dist-electron/…` or `localhost:51730`.
 */
export const isOwnPage = (url: string): boolean => {
  if (rendererUrl) {
    try {
      return new URL(url).origin === new URL(rendererUrl).origin;
    } catch {
      return false;
    }
  }
  return url.startsWith(`${rendererOrigin}/`);
};

const webPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  preload: join(rootPath, 'dist-electron/preload.cjs'),
  sandbox: true,
};

/** Loads the renderer at a hash route ('' = the calendar). */
const loadRenderer = (window: BrowserWindow, hash: string): void => {
  if (rendererUrl) {
    const url = new URL(rendererUrl);
    url.hash = hash;
    void window.loadURL(url.href);
  } else {
    void window.loadFile(join(rootPath, 'dist/index.html'), hash ? { hash } : {});
  }
};

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

export const hasMainWindow = (): boolean => mainWindow !== null;

export const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    height: 800,
    minHeight: 400,
    minWidth: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences,
    width: 1280,
  });
  mainWindow = window;
  window.once('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.once('ready-to-show', () => window.show());

  // Hidden from screen shares by default; the CALENDAR_CAPTURE debug hook
  // needs an unprotected window or its screenshot comes out black.
  if (!process.env.CALENDAR_CAPTURE) {
    registerPrivacyWindow(window);
  }

  // Debug/e2e hook: CALENDAR_CAPTURE=/path.png captures the window shortly
  // after load and quits.
  const capturePath = process.env.CALENDAR_CAPTURE;
  if (capturePath) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void window.webContents.capturePage().then((image) => {
          writeFileSync(capturePath, image.toPNG());
          app.quit();
        });
      }, 1500);
    });
  }

  loadRenderer(window, '');
  return window;
};

/** Brings the main window to the front, creating it when the app is running without one. */
export const showMainWindow = (): void => {
  if (!app.isReady()) {
    return;
  }
  const window = mainWindow;
  if (!window) {
    // A new window shows itself once it is ready.
    createMainWindow();
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
};

const settingsHash = (pane: string | undefined): string => (pane ? `settings/${pane}` : 'settings');

/**
 * Opens the settings window, or brings the one that exists to the front.
 * The pane lives in the URL hash, so there is no message to lose while the
 * page is still loading: a new window starts on `pane`, an open one is
 * navigated to it — a hash-only change, which the page sees as
 * `hashchange` without reloading. Without a pane the window reopens on
 * the one last viewed (the renderer remembers it).
 */
export const showSettingsWindow = (pane?: string): void => {
  if (!app.isReady()) {
    return;
  }
  const existing = settingsWindow;
  if (existing) {
    if (pane && new URL(existing.webContents.getURL()).hash !== `#${settingsHash(pane)}`) {
      loadRenderer(existing, settingsHash(pane));
    }
    existing.show();
    existing.focus();
    return;
  }
  // A settings window as macOS draws them: fixed size, close button only
  // (minimize and zoom dimmed), never full screen. The page draws the
  // title and the pane toolbar inside the hidden title bar.
  const window = new BrowserWindow({
    fullscreenable: false,
    height: 620,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    title: 'Settings',
    titleBarStyle: 'hidden',
    webPreferences,
    width: 680,
  });
  settingsWindow = window;
  window.once('closed', () => {
    if (settingsWindow === window) {
      settingsWindow = null;
    }
  });
  window.once('ready-to-show', () => window.show());
  registerPrivacyWindow(window);
  loadRenderer(window, settingsHash(pane));
};

/** `settings:open` — the sidebar's "Manage accounts…"; the menu calls showSettingsWindow itself. */
export const registerSettingsIpc = (): void => {
  ipcMain.handle('settings:open', (event, pane: unknown) => {
    if (!event.senderFrame || !isOwnPage(event.senderFrame.url)) {
      throw new Error('settings: untrusted sender');
    }
    // Only the shape is checked here; the page knows its panes and falls
    // back to the last viewed one for an id it does not have.
    showSettingsWindow(typeof pane === 'string' && /^[a-z]{1,32}$/.test(pane) ? pane : undefined);
  });
};
