import { Effect } from 'effect';
import { ipcMain } from 'electron';
import { desktopRemindersClient } from './remindersClient.ts';

/**
 * Reminders *permission* over plain preload IPC — a system-access concern
 * like the microphone prompt, not calendar data. Reminder rows themselves
 * flow through the typed rpc seam (sync + task mutations), never here.
 */
export const registerRemindersIpc = (): void => {
  ipcMain.handle('reminders:status', () =>
    Effect.runPromise(
      desktopRemindersClient.status().pipe(Effect.orElseSucceed(() => 'unavailable' as const)),
    ),
  );
  ipcMain.handle('reminders:request-access', () =>
    Effect.runPromise(
      desktopRemindersClient.requestAccess().pipe(Effect.orElseSucceed(() => false)),
    ),
  );
  ipcMain.handle('reminders:list-lists', () =>
    Effect.runPromise(
      desktopRemindersClient
        .listLists()
        .pipe(Effect.map((lists) => lists.map((list) => ({ id: list.id, title: list.title })))),
    ),
  );
};
