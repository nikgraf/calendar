import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
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
/** The settings window, and the pane asked for while its page was still loading. */
interface SettingsWindow {
  pendingPane?: string | undefined;
  readonly window: BrowserWindow;
}
let settings: SettingsWindow | null = null;

export const hasMainWindow = (): boolean => mainWindow !== null;

// The window's own color until the page paints, matching the canvas token of
// the OS appearance so a launch (or a reload) never flashes white at night.
const windowBackground = (): string => (nativeTheme.shouldUseDarkColors ? '#19171d' : '#ffffff');

export const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    backgroundColor: windowBackground(),
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
 * Moves the settings window to a pane by navigating the hash, which the
 * page sees as `hashchange` without reloading. Only once the page has
 * loaded: until the first navigation commits there is no URL to compare
 * (`getURL()` is empty — parsing it threw, and the request was lost), and
 * navigating then would abort the load in flight. So a pane asked for
 * while the window is still opening is kept, the last one winning, and
 * applied when loading stops.
 */
const moveSettingsTo = (pane: string): void => {
  if (!settings) {
    return;
  }
  const { webContents } = settings.window;
  const current = URL.parse(webContents.getURL());
  if (webContents.isLoading() || !current) {
    settings.pendingPane = pane;
    return;
  }
  if (current.hash !== `#${settingsHash(pane)}`) {
    loadRenderer(settings.window, settingsHash(pane));
  }
};

/**
 * Opens the settings window, or brings the one that exists to the front.
 * The pane lives in the URL hash: a new window starts on `pane`, an open
 * one is moved to it (moveSettingsTo). Without a pane the window reopens
 * on the one last viewed (the renderer remembers it).
 */
export const showSettingsWindow = (pane?: string): void => {
  if (!app.isReady()) {
    return;
  }
  if (settings) {
    if (pane) {
      moveSettingsTo(pane);
    }
    settings.window.show();
    settings.window.focus();
    return;
  }
  // A settings window as macOS draws them: fixed size, close button only
  // (minimize and zoom dimmed), never full screen. The page draws the
  // sidebar and the pane title inside the hidden title bar.
  const window = new BrowserWindow({
    backgroundColor: windowBackground(),
    fullscreenable: false,
    height: 560,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    title: 'Settings',
    titleBarStyle: 'hidden',
    webPreferences,
    width: 780,
  });
  const opened: SettingsWindow = { window };
  settings = opened;
  window.once('closed', () => {
    if (settings === opened) {
      settings = null;
    }
  });
  window.webContents.on('did-stop-loading', () => {
    const pending = opened.pendingPane;
    opened.pendingPane = undefined;
    if (pending && settings === opened) {
      moveSettingsTo(pending);
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
