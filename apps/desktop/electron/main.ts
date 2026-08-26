import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { updateElectronApp } from 'update-electron-app';
import { startBackendHost } from './backendHost.ts';
import { initFileLogging, logRendererError } from './log.ts';
import { initPrivacy, registerPrivacyWindow } from './privacy.ts';
import { registerModelHelper } from './modelHelper.ts';

const rootPath = fileURLToPath(new URL('..', import.meta.url));

// E2E hook: an isolated profile keeps test runs away from the real data.
if (process.env.CALENDAR_USERDATA) {
  app.setPath('userData', process.env.CALENDAR_USERDATA);
}

initFileLogging(app.getPath('userData'));
initPrivacy(app.getPath('userData'));
ipcMain.on('renderer-error', (_event, text: unknown) => {
  logRendererError(String(text));
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

  // Renderer window.open (e.g. the Join-meeting button) goes to the system
  // browser; no in-app popups.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

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

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
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
  startBackendHost();
  registerModelHelper();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
