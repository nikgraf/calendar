import { NotificationSink, noopNotificationSink, type NotificationSinkShape } from '@calendar/sync';
import { BrowserWindow, Notification } from 'electron';
import { Effect, Layer } from 'effect';

/**
 * Local notifications on macOS (event reminders, birthdays): a plain
 * Electron Notification the moment one is due, while the app runs (there
 * is no login item yet). A click brings the window back.
 * CALENDAR_NOTIFICATIONS=off (the e2e harness) swaps in the no-op sink so
 * a seeded event or birthday never posts a banner.
 */

/** A prompt left open this long counts as granted: unknown, so no nagging. */
const PERMISSION_WAIT = '60 seconds';

const focusWindow = () => {
  const window = BrowserWindow.getAllWindows()[0];
  window?.show();
  window?.focus();
};

/**
 * Electron has no query for the notification authorization: macOS asks
 * on the first show(), then emits 'show' or 'failed'. So the first start
 * (and turning notifications back on) posts a confirmation, which
 * doubles as the permission ask.
 */
const ensurePermission = () =>
  Effect.callback<boolean>((resume) => {
    if (!Notification.isSupported()) {
      resume(Effect.succeed(false));
      return;
    }
    const notification = new Notification({
      body: "You'll get reminders for events and birthdays while Solunivo is running.",
      title: 'Notifications are on',
    });
    notification.on('click', focusWindow);
    notification.on('show', () => resume(Effect.succeed(true)));
    notification.on('failed', (_event, error) =>
      resume(
        Effect.as(Effect.logWarning('notifications: permission check failed', { error }), false),
      ),
    );
    notification.show();
  }).pipe(Effect.timeoutOrElse({ duration: PERMISSION_WAIT, orElse: () => Effect.succeed(true) }));

const desktopSink: NotificationSinkShape = {
  ensurePermission,
  kind: 'immediate',
  show: (planned) =>
    Effect.sync(() => {
      if (!Notification.isSupported()) {
        return;
      }
      const notification = new Notification({ body: planned.body, title: planned.title });
      notification.on('click', focusWindow);
      // Denied or revoked permission drops the banner; leave a trace.
      notification.on('failed', (_event, error) =>
        console.warn('local notification failed', error),
      );
      notification.show();
    }),
};

export const desktopNotificationSink: Layer.Layer<NotificationSink> = Layer.succeed(
  NotificationSink,
  process.env['CALENDAR_NOTIFICATIONS'] === 'off' ? noopNotificationSink : desktopSink,
);
