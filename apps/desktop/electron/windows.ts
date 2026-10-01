import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { registerPrivacyWindow } from './privacy.ts';

/**
 * The main window, creatable at any time: the app keeps running without a
 * window on macOS (sync, reminders, the agent gateway), so anything that
 * needs the user's eyes — a Dock click, a notification, an agent asking
 * for approval — opens one on demand.
 */

const rootPath = fileURLToPath(new URL('..', import.meta.url));
export const rendererUrl = process.env.ELECTRON_RENDERER_URL;
/** Where the renderer is allowed to be: the vite dev server, or the built index. */
export const rendererOrigin = rendererUrl ?? pathToFileURL(join(rootPath, 'dist')).href;

export const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    height: 800,
    minHeight: 400,
    minWidth: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(rootPath, 'dist-electron/preload.cjs'),
      sandbox: true,
    },
    width: 1280,
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

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(rootPath, 'dist/index.html'));
  }
  return window;
};

/** Brings the window to the front, creating it when the app is running without one. */
export const showMainWindow = (): void => {
  if (!app.isReady()) {
    return;
  }
  const window = BrowserWindow.getAllWindows()[0];
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
