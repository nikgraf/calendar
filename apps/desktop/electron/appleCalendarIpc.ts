import { Effect } from 'effect';
import { ipcMain } from 'electron';
import { desktopAppleCalendarClient } from './appleCalendarClient.ts';

/**
 * Calendar permission *status* over plain preload IPC, like Reminders: a
 * system-access concern. The ask goes through the `connectAppleCalendar`
 * rpc (it also creates the account and syncs); events only ever cross the
 * typed rpc seam.
 */
export const registerAppleCalendarIpc = (): void => {
  ipcMain.handle('appleCalendar:status', () =>
    Effect.runPromise(
      desktopAppleCalendarClient.status().pipe(Effect.orElseSucceed(() => 'unavailable' as const)),
    ),
  );
};
