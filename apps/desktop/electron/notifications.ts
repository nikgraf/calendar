import { NotificationSink, noopNotificationSink, type NotificationSinkShape } from '@calendar/sync';
import { BrowserWindow, Notification } from 'electron';
import { Effect, Layer } from 'effect';

/**
 * Birthday reminders on macOS: a plain Electron Notification the moment
 * one is due, while the app runs (there is no login item yet). A click
 * brings the window back. CALENDAR_NOTIFICATIONS=off (the e2e harness)
 * swaps in the no-op sink so a seeded birthday never posts a banner.
 */
const desktopSink: NotificationSinkShape = {
  kind: 'immediate',
  show: (planned) =>
    Effect.sync(() => {
      if (!Notification.isSupported()) {
        return;
      }
      const notification = new Notification({ body: planned.body, title: planned.title });
      notification.on('click', () => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.show();
        window?.focus();
      });
      notification.show();
    }),
};

export const desktopNotificationSink: Layer.Layer<NotificationSink> = Layer.succeed(
  NotificationSink,
  process.env['CALENDAR_NOTIFICATIONS'] === 'off' ? noopNotificationSink : desktopSink,
);
