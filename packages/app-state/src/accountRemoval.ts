import type { Account, PendingOpSummary } from '@calendar/core';
import { AsyncResult } from 'effect/reactivity';

/**
 * The pending-op queue as read for a question that counts it: the ops once
 * read, or why they are not known. An empty list while loading, or after a
 * failed read, would look like "nothing unsynced" (see `usePendingOpsRead`).
 */
export type PendingOpsRead =
  | ReadonlyArray<Pick<PendingOpSummary, 'accountId'>>
  | 'failed'
  | 'loading';

/**
 * The queue atom's state as a `PendingOpsRead`. A success that is
 * refreshing still counts; a failed refresh does not, since the last good
 * read may be stale.
 */
export const pendingOpsRead = <A>(
  result: AsyncResult.AsyncResult<ReadonlyArray<A>, unknown>,
): ReadonlyArray<A> | 'failed' | 'loading' => {
  if (AsyncResult.isSuccess(result)) {
    return result.value;
  }
  return AsyncResult.isFailure(result) ? 'failed' : 'loading';
};

/**
 * What removing an account asks first, or undefined when it loses nothing.
 * An Apple account only disconnects: EventKit keeps everything and
 * reconnecting is a tap. A Google account takes its sign-in and its queued
 * changes with it, and coming back means signing in and importing its
 * history again — so it asks, and counts what would be lost. Until the
 * queue was read the count is unknown, and `canRemove` stays false.
 */
export const removeAccountQuestion = (
  account: Pick<Account, 'email' | 'id' | 'provider'>,
  queue: PendingOpsRead,
):
  | { readonly canRemove: boolean; readonly message: string; readonly title: string }
  | undefined => {
  if (account.provider !== 'google') {
    return undefined;
  }
  const title = `Remove ${account.email}?`;
  if (queue === 'loading') {
    return {
      canRemove: false,
      message: 'Checking for changes that have not reached Google yet…',
      title,
    };
  }
  if (queue === 'failed') {
    return {
      canRemove: false,
      message:
        'Solunivo could not check for changes that have not reached Google yet, so removing the account now could lose them. Try again in a moment.',
      title,
    };
  }
  const unsynced = queue.filter((op) => op.accountId === account.id).length;
  const lost =
    unsynced === 0
      ? ''
      : unsynced === 1
        ? ' 1 change has not reached Google yet and will be lost.'
        : ` ${unsynced} changes have not reached Google yet and will be lost.`;
  return {
    canRemove: true,
    message: `This signs out of ${account.email} on this device and deletes its local copy. Your calendars and tasks stay in Google.${lost}`,
    title,
  };
};
