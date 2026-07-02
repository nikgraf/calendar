import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

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

await app.whenReady();

createWindow();

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
