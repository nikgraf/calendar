import { LESSON_IDS } from '@calendar/core';
import { ipcMain } from 'electron';
import { isOwnPage, mainWindowContents, showMainWindow } from './windows.ts';

/**
 * `CALENDAR_ONBOARDING=off`: no first run and no Getting started card,
 * whatever the stored state says. The e2e harness sets it off by default
 * — every spec's seeded profile would otherwise open the setup dialog
 * over the calendar — and a spec opts in with `onboarding: 'on'`.
 */
const onboardingEnabled = process.env['CALENDAR_ONBOARDING'] !== 'off';

/**
 * Window-level onboarding concerns over plain preload IPC: whether it is
 * on at all, and `lesson:open` — Settings › Getting Started › Open lives
 * in the settings window, the lesson in the calendar window, so the
 * request hops through main: the calendar window is shown (created when
 * the app ran without one) and told which lesson, once its page can hear.
 */
export const registerOnboardingIpc = (): void => {
  ipcMain.handle('onboarding:enabled', () => onboardingEnabled);
  ipcMain.handle('lesson:open', (event, id: unknown) => {
    if (!event.senderFrame || !isOwnPage(event.senderFrame.url)) {
      throw new Error('lesson: untrusted sender');
    }
    if (typeof id !== 'string' || !LESSON_IDS.includes(id as (typeof LESSON_IDS)[number])) {
      return;
    }
    showMainWindow();
    const contents = mainWindowContents();
    if (!contents) {
      return;
    }
    if (contents.isLoading()) {
      // A window just created: its page listens only once it has loaded.
      contents.once('did-finish-load', () => contents.send('lesson:open', id));
    } else {
      contents.send('lesson:open', id);
    }
  });
};
