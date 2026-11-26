import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { basename } from 'node:path';
import { assistantModelManifest, type AssistantSession, sessionExportName } from '@calendar/ai';
import { Temporal } from '@calendar/core';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { sessionsFile, type SessionsState } from './assistantSessionsFile.ts';
import { isOwnPage } from './windows.ts';

/**
 * Keep Assistant Sessions on the Mac (Settings › AI Model): the switch,
 * the count, Export… (a save dialog) and Delete All over `sessions:*`
 * IPC, the log itself in the profile (`assistantSessionsFile.ts`). Every
 * window hears a change (`sessions:changed`). The calendar window hands
 * a finished thread over (`sessions:keep`); main stamps the app's version
 * on it. CALENDAR_SESSIONS_EXPORT names the file Export writes without a
 * dialog: the e2e harness's, under its temp profile.
 */

/**
 * The Assistant's model as a record names it: the one main serves (the
 * fixture, a file a run from source names, or the manifest's release).
 */
const modelName = (): string => {
  if (process.env['CALENDAR_MODEL'] === 'fixture') {
    return 'fixture';
  }
  const file = process.env['CALENDAR_ASSISTANT_MODEL_FILE']?.trim();
  return file
    ? `file:${basename(file)}`
    : `solunivo-assistant-${assistantModelManifest(process.env['CALENDAR_ASSISTANT_MANIFEST']).version}`;
};

/** A record this big is no thread of the Assistant's. */
const MAX_SESSION_CHARS = 2_000_000;

/** Every window hears the switch and the count. */
const tell = (state: SessionsState): SessionsState => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('sessions:changed', state);
  }
  return state;
};

/** Only this app's own pages switch, keep, export or delete. */
const trusted = (event: Electron.IpcMainInvokeEvent): boolean =>
  event.senderFrame !== null && isOwnPage(event.senderFrame.url);

export const registerAssistantSessions = (userDataDir: string): void => {
  const file = sessionsFile(userDataDir);

  ipcMain.handle('sessions:state', () => file.state());
  ipcMain.handle('sessions:set-on', (event, on: unknown) =>
    trusted(event) && typeof on === 'boolean' ? tell(file.setOn(on)) : file.state(),
  );
  ipcMain.handle('sessions:delete', (event) =>
    trusted(event) ? tell(file.delete()) : file.state(),
  );
  ipcMain.handle('sessions:keep', (event, session: unknown) => {
    if (
      !trusted(event) ||
      typeof session !== 'object' ||
      session === null ||
      JSON.stringify(session).length > MAX_SESSION_CHARS
    ) {
      return file.state();
    }
    const stamped = {
      ...(session as AssistantSession),
      app: { platform: 'Mac' as const, version: app.getVersion() },
      model: modelName(),
    };
    return tell(file.keep(stamped));
  });
  ipcMain.handle('sessions:export', async (event) => {
    if (!trusted(event)) {
      return { canceled: true };
    }
    const text = file.read();
    const fixed = process.env['CALENDAR_SESSIONS_EXPORT'];
    if (fixed) {
      writeFileSync(fixed, text, { mode: 0o600 });
      return { path: fixed };
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      defaultPath: join(
        app.getPath('downloads'),
        sessionExportName(Temporal.Now.plainDateISO().toString()),
      ),
      filters: [{ extensions: ['jsonl'], name: 'Assistant sessions' }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }
    writeFileSync(result.filePath, text, { mode: 0o600 });
    return { path: result.filePath };
  });
};
