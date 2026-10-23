import { LESSON_IDS, type LessonId } from '@calendar/core';
import { ipcMain } from 'electron';
import { isOwnPage, mainWindowContents, showMainWindow } from './windows.ts';

/**
 * `CALENDAR_ONBOARDING=off`: no first run and no Getting started card,
 * whatever the stored state says. The e2e harness sets it off by default
 * — every spec's seeded profile would otherwise open the setup dialog
 * over the calendar — and a spec opts in with `onboarding: 'on'`.
 */
const onboardingEnabled = process.env['CALENDAR_ONBOARDING'] !== 'off';

const isLessonId = (value: unknown): value is LessonId =>
  typeof value === 'string' && (LESSON_IDS as ReadonlyArray<string>).includes(value);

/**
 * The lesson Settings asked for, kept until the calendar window takes it:
 * a window that is still opening subscribes only once its first reads are
 * in, well after its page has loaded, so a message sent then would be
 * lost. The notification click's path, the same way (`notifications:take`).
 */
let pendingLesson: LessonId | null = null;

/**
 * Window-level onboarding concerns over plain preload IPC: whether it is
 * on at all, and the hop for Settings › Getting Started › Open — the
 * lesson lives in the calendar window, so `lesson:open` keeps the lesson,
 * shows that window (created when the app ran without one) and nudges it;
 * the calendar collects it with `lesson:take` when nudged and when it
 * subscribes.
 */
export const registerOnboardingIpc = (): void => {
  ipcMain.handle('onboarding:enabled', () => onboardingEnabled);
  ipcMain.handle('lesson:open', (event, id: unknown) => {
    if (!event.senderFrame || !isOwnPage(event.senderFrame.url)) {
      throw new Error('lesson: untrusted sender');
    }
    if (!isLessonId(id)) {
      return;
    }
    pendingLesson = id;
    showMainWindow();
    mainWindowContents()?.send('lesson:open');
  });
  ipcMain.handle('lesson:take', (event) => {
    if (
      !event.senderFrame ||
      !isOwnPage(event.senderFrame.url) ||
      event.sender !== mainWindowContents()
    ) {
      throw new Error('lesson: untrusted sender');
    }
    const id = pendingLesson;
    pendingLesson = null;
    return id;
  });
};
