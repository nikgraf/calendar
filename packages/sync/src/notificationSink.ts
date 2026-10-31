import type { NotificationTarget, PlannedNotification } from '@calendar/core';
import { Context, Effect } from 'effect';

/** A notification the OS has delivered and still shows, with what its payload carried. */
export interface DeliveredNotification {
  readonly dismissAt?: number | undefined;
  /** The plan key it was scheduled under. */
  readonly key: string;
  readonly target?: NotificationTarget | undefined;
}

/**
 * How a host delivers local notifications (event and birthday reminders).
 * Desktop shows a notification the moment it is due (the app is running,
 * or nothing fires); iOS hands the OS a schedule of upcoming ones so they
 * arrive with the app closed, and clears delivered ones whose moment has
 * passed. The LocalNotifications service narrows on `kind` and does the rest.
 *
 * `ensurePermission` asks the OS when undetermined; false means the user
 * declined. An immediate sink may have no way to ask but to post a
 * visible confirmation, so callers ask it only when reminders turn on.
 */
export type NotificationSinkShape =
  | {
      readonly ensurePermission: () => Effect.Effect<boolean>;
      readonly kind: 'immediate';
      readonly show: (notification: PlannedNotification) => Effect.Effect<void>;
    }
  | {
      /**
       * Reads the delivered notifications back and removes every one
       * `shouldDismiss` approves; pending ones are untouched. The sink
       * only translates — the rule (an event over, a task done) is the
       * scheduler's. Best-effort: the scheduler logs a failure and the
       * next pass tries again.
       */
      readonly dismissDelivered: (
        shouldDismiss: (delivered: DeliveredNotification) => Effect.Effect<boolean, unknown>,
      ) => Effect.Effect<void, unknown>;
      readonly ensurePermission: () => Effect.Effect<boolean>;
      readonly kind: 'scheduled';
      /**
       * Replaces every pending notification with these. Must fail when the
       * OS refused: the scheduler only records a schedule as delivered
       * after this succeeds, and retries the whole set on the next pass.
       */
      readonly replaceSchedule: (
        notifications: ReadonlyArray<PlannedNotification>,
      ) => Effect.Effect<void, unknown>;
    };

export class NotificationSink extends Context.Service<NotificationSink, NotificationSinkShape>()(
  'sync/NotificationSink',
) {}

/** Tests, e2e and builds without a notification path. */
export const noopNotificationSink: NotificationSinkShape = {
  ensurePermission: () => Effect.succeed(true),
  kind: 'immediate',
  show: () => Effect.void,
};
