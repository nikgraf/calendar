import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, nativeTheme, type WebContents } from 'electron';
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

/** The calendar window's page, when it has one: pushes meant for it alone. */
export const mainWindowContents = (): WebContents | undefined => mainWindow?.webContents;

// The window's own color until the page paints, matching the canvas token of
// the OS appearance so a launch (or a reload) never flashes white at night.
const windowBackground = (): string => (nativeTheme.shouldUseDarkColors ? '#19171d' : '#ffffff');

/** The e2e harness opens the window at a given size (`WxH`): CI's runner screen is smaller than a laptop's. */
const windowSize = (): { readonly height: number; readonly width: number } => {
  const match = /^(\d+)x(\d+)$/.exec(process.env['CALENDAR_E2E_WINDOW'] ?? '');
  return match
    ? { height: Number(match[2]), width: Number(match[1]) }
    : { height: 800, width: 1280 };
};

/**
 * The e2e harness's windows take input from CDP only (`CALENDAR_E2E_INPUT=cdp`):
 * they show without activating the app and keep the OS mouse out, so a key
 * typed or a trackpad touched during a local run goes to whatever the
 * developer is using, not to the test. CDP input enters below the window,
 * at the page itself, and still arrives; the harness emulates page focus.
 */
const cdpInputOnly = process.env['CALENDAR_E2E_INPUT'] === 'cdp';

/**
 * Keeps the OS mouse out of an e2e window. Ignoring mouse events passes
 * clicks, moves and scrolls through to the window below, but macOS still
 * tells the window when the cursor crosses it, and Chromium turns that into
 * a buttonless move: mid-drag, the page then drops the pointer capture.
 * What is left arrives as an enter or a leave, or at a fractional position
 * (the cursor moves in fractions of a point). CDP sends neither — the
 * harness dispatches whole pixels — so those are dropped before the page
 * sees them.
 */
const keepOsMouseOut = (window: BrowserWindow): void => {
  window.setIgnoreMouseEvents(true);
  window.webContents.on('before-mouse-event', (event, mouse) => {
    if (
      mouse.type === 'mouseEnter' ||
      mouse.type === 'mouseLeave' ||
      !Number.isInteger(mouse.x) ||
      !Number.isInteger(mouse.y)
    ) {
      event.preventDefault();
    }
  });
};

/** Shows a window, focused unless the e2e harness drives it (cdpInputOnly). */
const showWindow = (window: BrowserWindow, focus: boolean): void => {
  if (cdpInputOnly) {
    // Behind every other window (blur orders it to the back on macOS). A
    // covered page would run no rendering steps, but the harness's focus
    // emulation keeps it visible to itself, and it draws on.
    window.showInactive();
    window.blur();
    return;
  }
  window.show();
  if (focus) {
    window.focus();
  }
};

export const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    backgroundColor: windowBackground(),
    minHeight: 400,
    minWidth: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences,
    ...windowSize(),
  });
  mainWindow = window;
  window.once('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  if (cdpInputOnly) {
    keepOsMouseOut(window);
  }

  window.once('ready-to-show', () => showWindow(window, false));

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
  showWindow(window, true);
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
    showWindow(settings.window, true);
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
  if (cdpInputOnly) {
    keepOsMouseOut(window);
  }
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
  window.once('ready-to-show', () => showWindow(window, false));
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
