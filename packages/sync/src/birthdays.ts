import { BirthdayRecord, mergeBirthdays } from '@calendar/core';
import { AccountRepo, BirthdayRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { DeviceContacts } from './deviceContacts.ts';

/**
 * Every birthday the device knows, merged across sources: the Google
 * People cache (one record per account + contact, carrying the account's
 * email for the detail view) and the device address book. The range
 * query and the reminder planner both start here.
 */
export const loadMergedBirthdays: Effect.Effect<
  ReadonlyArray<BirthdayRecord>,
  SqlError,
  AccountRepo | BirthdayRepo | DeviceContacts
> = Effect.gen(function* () {
  const accounts = yield* (yield* AccountRepo).list();
  const emailOf = new Map(accounts.map((account) => [account.id, account.email]));
  const google = (yield* (yield* BirthdayRepo).listAll()).map((row) => {
    const id = `google:${row.accountId}:${row.resourceName}`;
    return new BirthdayRecord({
      day: row.day,
      displayName: row.displayName,
      id,
      month: row.month,
      sources: [
        {
          accountEmail: emailOf.get(row.accountId),
          accountId: row.accountId,
          id,
          source: 'google',
        },
      ],
      year: row.year,
    });
  });
  const device = yield* (yield* DeviceContacts).birthdays();
  return mergeBirthdays([...google, ...device]);
});
