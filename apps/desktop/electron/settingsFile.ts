import { mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DeviceSettingsRepo } from '@calendar/db';
import { buildSettingsDocument, importSettings } from '@calendar/sync';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { Effect, Schema } from 'effect';
import type { BackendHost } from './backendHost.ts';
import { subscribePrivacy } from './privacy.ts';
import {
  makeSettingsFileSync,
  SETTINGS_FILE_KEY,
  type SettingsFileApplied,
  type SettingsFileFs,
  type SettingsFileStatus,
} from './settingsFileSync.ts';

/**
 * The watched settings file. Default `~/.solunivo/solunivo.jsonc`; the e2e
 * harness points CALENDAR_SETTINGS_FILE under its temp profile so a test
 * never reads or writes a developer's real file. The window-level pieces
 * (file dialogs, status) are plain preload IPC; the document itself only
 * ever crosses the rpc seam.
 */
export const settingsFilePath = (): string =>
  process.env['CALENDAR_SETTINGS_FILE'] ?? join(homedir(), '.solunivo', 'solunivo.jsonc');

const AppliedRow = Schema.Struct({ appliedAt: Schema.Number, hash: Schema.String });
const decodeApplied = Schema.decodeUnknownOption(AppliedRow);

const nodeFs: SettingsFileFs = {
  exists: (path) => {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  },
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  watchDir: (dir, onChange) => {
    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      onChange(filename === null ? null : basename(String(filename)));
    });
    return () => watcher.close();
  },
  writeTextAtomic: (path, text) => {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
  },
};

const broadcast = (status: SettingsFileStatus) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('settingsFile:changed', status);
  }
};

export const startSettingsFile = (host: BackendHost): void => {
  const path = settingsFilePath();
  const sync = makeSettingsFileSync(path, {
    exportDocument: () => host.run(buildSettingsDocument),
    fs: nodeFs,
    importDocument: (document) => host.run(importSettings(document)),
    log: (message, meta) => console.log(`[settings-file] ${message}`, meta ?? ''),
    readLastApplied: () =>
      host.run(
        Effect.map(
          Effect.flatMap(DeviceSettingsRepo, (repo) => repo.get(SETTINGS_FILE_KEY)),
          (raw): SettingsFileApplied | null => {
            const decoded = decodeApplied(raw);
            return decoded._tag === 'Some' ? decoded.value : null;
          },
        ),
      ),
    writeLastApplied: (applied) =>
      host.run(Effect.flatMap(DeviceSettingsRepo, (repo) => repo.set(SETTINGS_FILE_KEY, applied))),
  });
  sync.subscribeStatus(broadcast);

  ipcMain.handle('settingsFile:status', () => sync.status());
  ipcMain.handle('settingsFile:create', async () => {
    await sync.createFromState();
    return sync.status();
  });
  ipcMain.handle('settingsFile:save', async (event, text: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      defaultPath: join(app.getPath('downloads'), 'solunivo.jsonc'),
      filters: [{ extensions: ['jsonc', 'json'], name: 'Solunivo settings' }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }
    nodeFs.writeTextAtomic(result.filePath, String(text));
    return { path: result.filePath };
  });
  ipcMain.handle('settingsFile:open', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      filters: [{ extensions: ['jsonc', 'json'], name: 'Solunivo settings' }],
      properties: ['openFile' as const],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) {
      return { canceled: true };
    }
    return { path: filePath, text: readFileSync(filePath, 'utf8') };
  });

  host.ready
    .then(async () => {
      host.subscribeInvalidations(sync.onInvalidation);
      subscribePrivacy(() => sync.onPlatformChange());
      await sync.start();
    })
    .catch((error: unknown) => {
      console.error('[settings-file] start failed:', error);
    });
  app.on('will-quit', () => sync.stop());
};
