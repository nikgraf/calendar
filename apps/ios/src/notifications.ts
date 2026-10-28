import { type NotificationTarget, parseNotificationTarget } from '@calendar/core';
import { NotificationSink, noopNotificationSink } from '@calendar/sync';
import { Layer } from 'effect';
import { makeIosNotificationSink } from './notificationSink.ts';

/**
 * Event and birthday reminders on iOS: the OS delivers pre-scheduled
 * local notifications, so they arrive with the app closed, and a
 * delivered event reminder is dismissed once the event is over
 * (`notificationSink.ts`).
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

const native = load();

export const iosNotificationSink: Layer.Layer<NotificationSink> = Layer.succeed(
  NotificationSink,
  native ? makeIosNotificationSink(native) : noopNotificationSink,
);

/** Responses already acted on: the launch response can arrive twice (listener and last response). */
const handled = new Set<string>();

/**
 * Calls `listener` with the target of every notification the user taps —
 * the one that launched the app too — once each.
 */
export const subscribeNotificationTaps = (
  listener: (target: NotificationTarget) => void,
): (() => void) => {
  const notifications = native;
  if (!notifications) {
    return () => {};
  }
  const take = (response: import('expo-notifications').NotificationResponse | null) => {
    if (!response || response.actionIdentifier !== notifications.DEFAULT_ACTION_IDENTIFIER) {
      return;
    }
    const { date, request } = response.notification;
    const id = `${request.identifier}@${String(date)}`;
    if (handled.has(id)) {
      return;
    }
    handled.add(id);
    const target = parseNotificationTarget(request.content.data?.['target']);
    if (target) {
      listener(target);
    }
  };
  const subscription = notifications.addNotificationResponseReceivedListener(take);
  void notifications
    .getLastNotificationResponseAsync()
    .then((response) => {
      take(response);
      return notifications.clearLastNotificationResponseAsync();
    })
    .catch(() => undefined);
  return () => subscription.remove();
};

export type NotificationPermission = 'denied' | 'granted' | 'undetermined' | 'unavailable';

/** What iOS allows now, without asking: a denial only the Settings app can undo. */
export const notificationPermission = async (): Promise<NotificationPermission> => {
  if (!native) {
    return 'unavailable';
  }
  try {
    const current = await native.getPermissionsAsync();
    return current.granted ? 'granted' : current.status === 'denied' ? 'denied' : 'undetermined';
  } catch {
    return 'unavailable';
  }
};
