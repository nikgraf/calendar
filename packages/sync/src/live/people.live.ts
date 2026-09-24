import { BirthdayRepo, ContactRepo, SyncStateRepo } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';
import {
  LIVE_ACCOUNT_ID,
  liveEngineLayer,
  liveGoogleConfigFromEnv,
} from '../testing/liveGoogle.ts';
import { bootstrap, scratchFor } from './support.ts';

/**
 * The People API on the real account: both tiers complete with a sync
 * token even on an empty address book, and cached rows have the shape the
 * typeahead expects. The account's contacts are whatever was set up by
 * hand, so this is a shape check; `GOOGLE_LIVE_BIRTHDAY_NAME` names a
 * contact with a birthday when one was added.
 */

const config = liveGoogleConfigFromEnv();
scratchFor(config, {});

describe('live Google: People', () => {
  it.live('both contact tiers finish with a sync token', () =>
    Effect.gen(function* () {
      yield* bootstrap(config, { contactsEnabled: true });
      const state = yield* SyncStateRepo;
      for (const scope of ['contacts:connections', 'contacts:other']) {
        const row = yield* state.get(LIVE_ACCOUNT_ID, scope);
        expect(row?.status, scope).toBe('idle');
        expect(row?.syncToken, scope).toBeTruthy();
      }
      const contacts = yield* (yield* ContactRepo).listByAccount(LIVE_ACCOUNT_ID);
      for (const contact of contacts) {
        expect(contact.email).toBe(contact.email.toLowerCase());
        expect(contact.source).toBe('google');
      }
      const birthdayName = process.env['GOOGLE_LIVE_BIRTHDAY_NAME'];
      if (birthdayName) {
        const birthdays = yield* (yield* BirthdayRepo).listAll();
        expect(birthdays.map((row) => row.displayName)).toContain(birthdayName);
      }
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
