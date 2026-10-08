import type { NotificationTarget } from '@calendar/core';

/**
 * The event reminder clicked last, until the calendar window takes it. A
 * click shows the window (or opens one, since the app runs without any)
 * and pushes `notifications:open`; a page that is still loading misses the
 * push and takes the target when it subscribes. One target at a time: a
 * later click replaces one not yet taken.
 */
export const makeNotificationTargets = (deps: {
  /** Tells an open calendar page to take the target now. */
  readonly push: () => void;
  readonly showWindow: () => void;
}) => {
  let pending: NotificationTarget | undefined;
  return {
    open: (target: NotificationTarget | undefined): void => {
      pending = target;
      deps.showWindow();
      if (target) {
        deps.push();
      }
    },
    take: (): NotificationTarget | null => {
      const target = pending ?? null;
      pending = undefined;
      return target;
    },
  };
};
