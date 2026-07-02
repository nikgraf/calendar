import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { startBackendHost } from './backendHost.ts';

const rootPath = fileURLToPath(new URL('..', import.meta.url));

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
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
