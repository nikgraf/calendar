import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { updateElectronApp } from 'update-electron-app';
import { startBackendHost } from './backendHost.ts';
import { initFileLogging, logRendererError } from './log.ts';
import { initPrivacy, registerPrivacyWindow } from './privacy.ts';
import { registerModelHelper } from './modelHelper.ts';
import { registerContactsIpc } from './contactsIpc.ts';
import { registerRemindersIpc } from './remindersIpc.ts';

const rootPath = fileURLToPath(new URL('..', import.meta.url));
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
/** Where the renderer is allowed to be: the vite dev server, or the built index. */
const rendererOrigin = rendererUrl ?? pathToFileURL(join(rootPath, 'dist')).href;

/**
 * The renderer loads nothing remote: scripts and styles are its own
 * bundle (Tailwind emits a stylesheet; React sets inline style
 * attributes, hence 'unsafe-inline' for styles only), images are account
 * avatars from Google, and every request goes over the preload IPC. Not
 * applied against the vite dev server, whose HMR needs inline scripts
 * and a websocket.
 */
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
/** A renderer error report is one message, not a log dump. */
const MAX_RENDERER_ERROR_CHARS = 8000;

// E2E hook: an isolated profile keeps test runs away from the real data.
if (process.env.CALENDAR_USERDATA) {
  app.setPath('userData', process.env.CALENDAR_USERDATA);
}

initFileLogging(app.getPath('userData'));
initPrivacy(app.getPath('userData'));
ipcMain.on('renderer-error', (_event, text: unknown) => {
  logRendererError(String(text).slice(0, MAX_RENDERER_ERROR_CHARS));
});

/**
 * Every web contents this app creates stays on its own page: a
 * renderer-initiated navigation would hand remote content the whole
 * preload bridge, rpc included. Links open in the system browser — any
 * https host, since meeting links live on arbitrary domains — and never
 * as in-app windows.
 */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(rendererOrigin)) {
      event.preventDefault();
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
});

// Auto-update from GitHub releases. Only meaningful in packaged builds and
// once releases are published from a public repo with a signed app —
// update-electron-app is a no-op otherwise, so it is safe to always wire.
if (app.isPackaged) {
  try {
    updateElectronApp({ repo: 'nikgraf/calendar', updateInterval: '1 hour' });
  } catch {
    // Missing signature/releases must never break app startup.
  }
}

const createWindow = () => {
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
};

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Electron emits 'ready' only after the main module finishes evaluating, so
// top-level-awaiting whenReady() deadlocks the app. Promise chain required.
// eslint-disable-next-line unicorn/prefer-top-level-await
void app.whenReady().then(() => {
  if (!rendererUrl) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [RENDERER_CSP],
        },
      });
    });
  }
  startBackendHost();
  registerModelHelper();
  registerRemindersIpc();
  registerContactsIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
