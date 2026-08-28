import { useMemo } from 'react';
import { useBackendMutations } from './hooks.ts';

/**
 * Fire-and-forget mutation guard. Optimistic writes make most mutations feel
 * instant, so many call sites intentionally don't await them — but a rejected
 * promise then vanished into an unhandled rejection and the UI silently
 * snapped back (worst case: a drag-reschedule reverting with no explanation).
 * Guarded mutations never reject; failures publish a MutationNotice that the
 * app shells render as a toast.
 */
export interface MutationNotice {
  /** Human-readable description of what failed, e.g. "reschedule the event". */
  readonly action: string;
  /** Truncated failure detail for the toast's second line. */
  readonly detail: string;
}

type NoticeListener = (notice: MutationNotice) => void;

const listeners = new Set<NoticeListener>();

/** UI shells subscribe once and render notices as toasts. */
export const subscribeMutationNotices = (listener: NoticeListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const publish = (notice: MutationNotice): void => {
  for (const listener of listeners) {
    listener(notice);
  }
};

const MAX_DETAIL = 140;

/**
 * Wrap a promise-returning mutation: the result never rejects; a rejection
 * publishes a MutationNotice instead. Exported for tests.
 */
export const guardMutation =
  <Args extends ReadonlyArray<unknown>>(
    action: string,
    run: (...args: Args) => Promise<unknown>,
  ): ((...args: Args) => Promise<void>) =>
  (...args) =>
    run(...args).then(
      () => undefined,
      (error: unknown) => {
        const raw = error instanceof Error ? error.message : String(error);
        publish({
          action,
          detail: raw.length > MAX_DETAIL ? `${raw.slice(0, MAX_DETAIL)}…` : raw,
        });
      },
    );

/**
 * `useBackendMutations`, but fire-and-forget-safe: same keys, every function
 * resolves (void) and reports failures through the notice bus. Use this at
 * call sites that don't have their own error UI; editors that show inline
 * errors keep using `useBackendMutations` directly.
 */
export const useGuardedMutations = () => {
  const mutations = useBackendMutations();
  return useMemo(
    () => ({
      addAccount: guardMutation('connect the account', mutations.addAccount),
      completeTask: guardMutation('update the task', mutations.completeTask),
      discardPendingOp: guardMutation('discard the change', mutations.discardPendingOp),
      removeAccount: guardMutation('remove the account', mutations.removeAccount),
      setCalendarColor: guardMutation('change the calendar color', mutations.setCalendarColor),
      setCalendarVisible: guardMutation('toggle the calendar', mutations.setCalendarVisible),
      setTaskListVisible: guardMutation('toggle the task list', mutations.setTaskListVisible),
      updateEvent: guardMutation('reschedule the event', mutations.updateEvent),
      updateRecurring: guardMutation('reschedule the event', mutations.updateRecurring),
    }),
    [mutations],
  );
};
