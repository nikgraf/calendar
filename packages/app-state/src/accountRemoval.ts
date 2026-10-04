import type { Account, PendingOpSummary } from '@calendar/core';

/**
 * What removing an account asks first, or undefined when it loses nothing.
 * An Apple account only disconnects: EventKit keeps everything and
 * reconnecting is a tap. A Google account takes its sign-in and its queued
 * changes with it, and coming back means signing in and importing its
 * history again — so it asks, and counts what would be lost.
 */
export const removeAccountQuestion = (
  account: Pick<Account, 'email' | 'id' | 'provider'>,
  pendingOps: ReadonlyArray<Pick<PendingOpSummary, 'accountId'>>,
): { readonly message: string; readonly title: string } | undefined => {
  if (account.provider !== 'google') {
    return undefined;
  }
  const unsynced = pendingOps.filter((op) => op.accountId === account.id).length;
  const lost =
    unsynced === 0
      ? ''
      : unsynced === 1
        ? ' 1 change has not reached Google yet and will be lost.'
        : ` ${unsynced} changes have not reached Google yet and will be lost.`;
  return {
    message: `This signs out of ${account.email} on this device and deletes its local copy. Your calendars and tasks stay in Google.${lost}`,
    title: `Remove ${account.email}?`,
  };
};
