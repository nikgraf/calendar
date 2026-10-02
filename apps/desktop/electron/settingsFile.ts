import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DeviceSettingsRepo } from '@calendar/db';
import { buildSettingsDocument, importSettings } from '@calendar/sync';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { Effect, Schema } from 'effect';
import type { BackendHost } from './backendHost.ts';
import { subscribePrivacy } from './privacy.ts';
import { nodeSettingsFileFs } from './settingsFileFs.ts';
import {
  makeSettingsFileSync,
  SETTINGS_FILE_KEY,
  type SettingsFileApplied,
  settingsFilePath,
  type SettingsFileStatus,
} from './settingsFileSync.ts';

const AppliedRow = Schema.Struct({ appliedAt: Schema.Number, hash: Schema.String });
const decodeApplied = Schema.decodeUnknownOption(AppliedRow);

const broadcast = (status: SettingsFileStatus) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('settingsFile:changed', status);
  }
};

/**
 * The watched settings file. Default `~/.solunivo/solunivo.jsonc`
 * (`solunivo-dev.jsonc` for a dev build); the e2e harness points
 * CALENDAR_SETTINGS_FILE under its temp profile so a test never reads or
 * writes a developer's real file. The window-level pieces (file dialogs,
 * status) are plain preload IPC; the document itself only ever crosses the
 * rpc seam.
 */
export const startSettingsFile = (host: BackendHost): void => {
  const path = settingsFilePath({ env: process.env, home: homedir(), packaged: app.isPackaged });
  const sync = makeSettingsFileSync(path, {
    exportDocument: () => host.run(buildSettingsDocument),
    fs: nodeSettingsFileFs,
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

  // Opening Settings re-checks the disk first, so the status line is never
  // older than the last look.
  ipcMain.handle('settingsFile:status', async () => {
    await sync.checkNow();
    return sync.status();
  });
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
    nodeSettingsFileFs.writeTextAtomic(result.filePath, String(text));
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
  // Coming back to the app after running a setup script or editing the
  // file elsewhere: check right away instead of waiting for the next poll.
  app.on('browser-window-focus', () => void sync.checkNow());
  app.on('will-quit', () => sync.stop());
};
