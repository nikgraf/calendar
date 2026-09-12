import type { PlannedNotification } from '@calendar/core';
import { Context, Effect } from 'effect';

/**
 * How a host delivers birthday reminders. Desktop shows a notification
 * the moment it is due (the app is running, or nothing fires); iOS hands
 * the OS a schedule of upcoming ones so they arrive with the app closed.
 * The BirthdayReminders service narrows on `kind` and does the rest.
 */
export type NotificationSinkShape =
  | {
      readonly kind: 'immediate';
      readonly show: (notification: PlannedNotification) => Effect.Effect<void>;
    }
  | {
      /** Asks the OS when undetermined; false means the user declined. */
      readonly ensurePermission: () => Effect.Effect<boolean>;
      readonly kind: 'scheduled';
      /** Replaces every pending notification with these. */
      readonly replaceSchedule: (
        notifications: ReadonlyArray<PlannedNotification>,
      ) => Effect.Effect<void>;
    };

export class NotificationSink extends Context.Service<NotificationSink, NotificationSinkShape>()(
  'sync/NotificationSink',
) {}

/** Tests, e2e and builds without a notification path. */
export const noopNotificationSink: NotificationSinkShape = {
  kind: 'immediate',
  show: () => Effect.void,
};
