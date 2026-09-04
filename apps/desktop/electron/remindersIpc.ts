import { Effect } from 'effect';
import { ipcMain } from 'electron';
import { desktopRemindersClient } from './remindersClient.ts';

/**
 * Reminders permission *status* over plain preload IPC — a system-access
 * concern like the microphone prompt, not calendar data. The ask itself
 * goes through the `connectReminders` rpc (it also creates the account
 * and syncs); reminder rows only ever flow through the typed rpc seam.
 */
export const registerRemindersIpc = (): void => {
  ipcMain.handle('reminders:status', () =>
    Effect.runPromise(
      desktopRemindersClient.status().pipe(Effect.orElseSucceed(() => 'unavailable' as const)),
    ),
  );
};
