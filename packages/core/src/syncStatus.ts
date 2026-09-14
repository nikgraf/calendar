import { Schema } from 'effect';

/** Per account: how far the events history import has come. */
export class AccountSyncStatus extends Schema.Class<AccountSyncStatus>('AccountSyncStatus')({
  accountId: Schema.String,
  /** Rows in the events table for this account (all calendars). */
  eventCount: Schema.Number,
  /** At least one calendar is still on its first full list (or a resync). */
  importing: Schema.Boolean,
}) {}

/**
 * The Settings line under a Google account, the same on both platforms.
 * Null when there is nothing to say (no events, nothing importing).
 */
export const historyStatusLabel = (
  status: Pick<AccountSyncStatus, 'eventCount' | 'importing'>,
): string | null => {
  if (status.importing) {
    return `Importing history… ${status.eventCount.toLocaleString('en-US')} events so far`;
  }
  return status.eventCount === 0 ? null : 'History complete';
};
