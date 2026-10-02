import { app, ipcMain, session, shell } from 'electron';
import { updateElectronApp } from 'update-electron-app';
import { startAgentHost } from './agent/agentHost.ts';
import { startBackendHost } from './backendHost.ts';
import { startSettingsFile } from './settingsFile.ts';
import { initFileLogging, logRendererError } from './log.ts';
import { installApplicationMenu } from './menu.ts';
import { initPrivacy } from './privacy.ts';
import { registerModelHelper } from './modelHelper.ts';
import { registerAppleCalendarIpc } from './appleCalendarIpc.ts';
import { registerContactsIpc } from './contactsIpc.ts';
import { registerRemindersIpc } from './remindersIpc.ts';
import {
  createMainWindow,
  hasMainWindow,
  isOwnPage,
  registerSettingsIpc,
  rendererUrl,
  showMainWindow,
} from './windows.ts';

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

/**
 * One instance per profile. Two would run two sync engines on one
 * database and fight over the agent socket. The lock lives in userData,
 * so it must be taken after the override above — an e2e run on its temp
 * profile never collides with a developer's running app.
 */
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

/**
 * `--background`: started on an agent's behalf (the CLI relay found no
 * running app). Everything starts except the window; the Dock icon, a
 * notification or an approval request opens one.
 */
const startInBackground = process.argv.includes('--background');

// A second launch hands over to this instance: show the window, unless
// that launch was itself a background start.
app.on('second-instance', (_event, argv) => {
  if (!argv.includes('--background')) {
    showMainWindow();
  }
});

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
    if (!isOwnPage(url)) {
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Electron emits 'ready' only after the main module finishes evaluating, so
// top-level-awaiting whenReady() deadlocks the app. Promise chain required.
// eslint-disable-next-line unicorn/prefer-top-level-await
void app.whenReady().then(() => {
  if (!isPrimaryInstance) {
    return;
  }
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
  const host = startBackendHost();
  startSettingsFile(host);
  startAgentHost(host);
  registerModelHelper();
  registerRemindersIpc();
  registerContactsIpc();
  registerAppleCalendarIpc();
  registerSettingsIpc();
  installApplicationMenu();
  if (!startInBackground) {
    createMainWindow();
  }

  // A Dock click brings the calendar back, also when only the settings
  // window is open.
  app.on('activate', () => {
    if (!hasMainWindow()) {
      createMainWindow();
    }
  });
});
