import { NotificationSink, noopNotificationSink, type NotificationSinkShape } from '@calendar/sync';
import { Effect, Layer } from 'effect';

/**
 * Birthday reminders on iOS: the OS delivers pre-scheduled local
 * notifications, so they arrive with the app closed. The scheduler hands
 * over the next batch whenever it changes; this sink only translates.
 *
 * Loaded with `require` in a try/catch, like the speech and contacts
 * modules: expo-notifications registers its native module at import
 * time and a dev client built before the dependency existed would crash
 * at launch — the OTA preview path ships exactly such binaries. Without
 * the module the app simply has no notification path.
 */
const load = () => {
  try {
    // eslint-disable-next-line typescript/no-require-imports -- deliberate: see above
    return require('expo-notifications') as typeof import('expo-notifications');
  } catch {
    return undefined;
  }
};

const makeSink = (notifications: typeof import('expo-notifications')): NotificationSinkShape => {
  // Banners in the foreground too: a reminder set for 09:00 should show
  // even while the calendar is open.
  notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
  });
  return {
    ensurePermission: () =>
      Effect.tryPromise(async () => {
        const current = await notifications.getPermissionsAsync();
        if (current.granted) {
          return true;
        }
        if (!current.canAskAgain) {
          return false;
        }
        return (await notifications.requestPermissionsAsync()).granted;
      }).pipe(Effect.orElseSucceed(() => false)),
    kind: 'scheduled',
    replaceSchedule: (planned) =>
      Effect.tryPromise(async () => {
        await notifications.cancelAllScheduledNotificationsAsync();
        for (const item of planned) {
          await notifications.scheduleNotificationAsync({
            content: { body: item.body, title: item.title },
            identifier: item.key,
            trigger: {
              date: new Date(item.fireAt),
              type: notifications.SchedulableTriggerInputTypes.DATE,
            },
          });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('scheduling birthday reminders failed', { cause: String(cause) }),
        ),
      ),
  };
};

const native = load();

export const iosNotificationSink: Layer.Layer<NotificationSink> = Layer.succeed(
  NotificationSink,
  native ? makeSink(native) : noopNotificationSink,
);
