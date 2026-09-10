import { Effect } from 'effect';
import { ipcMain } from 'electron';
import { desktopContactsClient } from './contactsClient.ts';

/**
 * Contacts permission *status* over plain preload IPC — a system-access
 * concern like the Reminders one. The ask itself goes through the
 * `connectContacts` rpc; contact rows only ever flow through the typed
 * rpc seam (searchContacts).
 */
export const registerContactsIpc = (): void => {
  ipcMain.handle('contacts:status', () =>
    Effect.runPromise(
      desktopContactsClient.status().pipe(Effect.orElseSucceed(() => 'unavailable' as const)),
    ),
  );
};
