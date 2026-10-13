import { execFile } from 'node:child_process';
import { Effect } from 'effect';
import { ipcMain } from 'electron';
import { desktopAppleCalendarClient } from './appleCalendarClient.ts';

/**
 * Calendar permission *status* over plain preload IPC, like Reminders: a
 * system-access concern. The ask goes through the `connectAppleCalendar`
 * rpc (it also creates the account and syncs); events only ever cross the
 * typed rpc seam.
 *
 * `appleCalendar:open` brings Calendar.app forward — the editor's way to
 * the invitees EventKit cannot write. Only with the real EventKit: under
 * the e2e fixture (or off) it answers false and opens nothing, so a run
 * never raises a developer's Calendar.
 */
export const registerAppleCalendarIpc = (): void => {
  ipcMain.handle('appleCalendar:status', () =>
    Effect.runPromise(
      desktopAppleCalendarClient.status().pipe(Effect.orElseSucceed(() => 'unavailable' as const)),
    ),
  );
  ipcMain.handle('appleCalendar:open', () => {
    const mode = process.env['CALENDAR_APPLE_CALENDAR'];
    if (mode === 'fixture' || mode === 'off') {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      execFile('/usr/bin/open', ['-b', 'com.apple.iCal'], (error) => resolve(error === null));
    });
  });
};
