import type { NotificationSinkShape } from '@calendar/sync';
import { Effect, Predicate } from 'effect';
import type {
  NotificationHandler,
  NotificationPermissionsStatus,
  NotificationRequestInput,
} from 'expo-notifications';

type ExpoNotifications = typeof import('expo-notifications');

/** A delivered notification as the OS lists it: its request, with the payload the app gave it. */
export interface PresentedNotification {
  readonly request: {
    readonly content: { readonly data?: Record<string, unknown> | undefined };
    readonly identifier: string;
  };
}

/** The slice of expo-notifications the sink uses; faked in tests. */
export interface NotificationsModule {
  readonly cancelAllScheduledNotificationsAsync: () => Promise<void>;
  /** Removes one delivered notification from Notification Center. */
  readonly dismissNotificationAsync: (identifier: string) => Promise<void>;
  readonly getPermissionsAsync: () => Promise<
    Pick<NotificationPermissionsStatus, 'canAskAgain' | 'granted'>
  >;
  /** The delivered notifications still in Notification Center. */
  readonly getPresentedNotificationsAsync: () => Promise<ReadonlyArray<PresentedNotification>>;
  readonly requestPermissionsAsync: () => Promise<Pick<NotificationPermissionsStatus, 'granted'>>;
  readonly SchedulableTriggerInputTypes: Pick<
    ExpoNotifications['SchedulableTriggerInputTypes'],
    'DATE'
  >;
  readonly scheduleNotificationAsync: (request: NotificationRequestInput) => Promise<string>;
  readonly setNotificationHandler: (handler: NotificationHandler | null) => void;
}

/**
 * The iOS sink: the OS delivers pre-scheduled local notifications, so
 * event and birthday reminders arrive with the app closed. The scheduler
 * hands over the next batch whenever it changes and, every pass, has the
 * delivered reminders whose event is over dismissed; this sink only
 * translates. Built from the module's slice, apart from its `require`
 * (`notifications.ts`): expo-notifications registers its native module at
 * import time, so a test feeds this factory a fake instead.
 */
export const makeIosNotificationSink = (
  notifications: NotificationsModule,
): NotificationSinkShape => {
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
    // The OS keeps the delivered list and each payload says when it is
    // done — read back as OS data, never trusted. One without a deadline
    // (a birthday, a reminder an older build scheduled) stays.
    dismissDelivered: (now) =>
      Effect.tryPromise(async () => {
        for (const { request } of await notifications.getPresentedNotificationsAsync()) {
          const dismissAt = request.content.data?.['dismissAt'];
          if (Predicate.isNumber(dismissAt) && dismissAt <= now) {
            await notifications.dismissNotificationAsync(request.identifier);
          }
        }
      }),
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
    // A failure propagates: the scheduler must not remember a schedule
    // the OS never accepted. Identifiers are stable, so a retry after a
    // partial failure replaces rather than duplicates.
    replaceSchedule: (planned) =>
      Effect.tryPromise(async () => {
        await notifications.cancelAllScheduledNotificationsAsync();
        for (const item of planned) {
          await notifications.scheduleNotificationAsync({
            content: {
              body: item.body,
              // When a delivered one is done, and what a tap opens
              // (dismissDelivered and subscribeNotificationTaps read them back).
              data: {
                ...(item.dismissAt === undefined ? {} : { dismissAt: item.dismissAt }),
                ...(item.target ? { target: item.target } : {}),
              },
              title: item.title,
            },
            identifier: item.key,
            trigger: {
              date: new Date(item.fireAt),
              type: notifications.SchedulableTriggerInputTypes.DATE,
            },
          });
        }
      }),
  };
};
