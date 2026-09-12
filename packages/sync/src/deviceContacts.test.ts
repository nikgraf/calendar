import {
  ContactsClient,
  type ContactsClientShape,
  ContactsRequestError,
  makeFakeContactsClient,
} from '@calendar/contacts';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { describe } from 'vitest';
import { DeviceContacts } from './deviceContacts.ts';

const alice = { contactId: 'c1', displayName: 'Alice', email: 'alice@example.com' };

describe('DeviceContacts', () => {
  it.effect('a burst of lookups against a stale cache takes one snapshot', () => {
    const { client, state } = makeFakeContactsClient({ contacts: [alice] });
    return Effect.gen(function* () {
      const contacts = yield* DeviceContacts;
      const results = yield* Effect.all([contacts.list(), contacts.list(), contacts.list()], {
        concurrency: 'unbounded',
      });
      for (const result of results) {
        expect(result.map((contact) => contact.email)).toEqual(['alice@example.com']);
      }
      expect(state.calls.filter((call) => call === 'snapshot')).toHaveLength(1);
    }).pipe(
      Effect.provide(
        DeviceContacts.layer.pipe(Layer.provide(Layer.succeed(ContactsClient, client))),
      ),
    );
  });

  it.effect('a failed snapshot keeps the previous contacts and retries soon', () => {
    const { client, state } = makeFakeContactsClient({ contacts: [alice] });
    let failing = false;
    const flaky: ContactsClientShape = {
      ...client,
      snapshot: () =>
        failing
          ? Effect.fail(new ContactsRequestError({ message: 'bridge died', method: 'snapshot' }))
          : client.snapshot(),
    };
    return Effect.gen(function* () {
      const contacts = yield* DeviceContacts;
      expect(yield* contacts.list()).toHaveLength(1);

      // The bridge fails on the stale refetch: the old list stays, and
      // the failure is not cached as a fresh empty snapshot.
      failing = true;
      state.contacts.push({ contactId: 'c2', displayName: 'Bob', email: 'bob@example.com' });
      yield* TestClock.adjust('6 minutes');
      expect((yield* contacts.list()).map((contact) => contact.email)).toEqual([
        'alice@example.com',
      ]);

      // 31 s later the next lookup tries again instead of waiting five
      // minutes, and picks up the change.
      failing = false;
      yield* TestClock.adjust('31 seconds');
      expect((yield* contacts.list()).map((contact) => contact.email)).toEqual([
        'alice@example.com',
        'bob@example.com',
      ]);
    }).pipe(
      Effect.provide(
        DeviceContacts.layer.pipe(Layer.provide(Layer.succeed(ContactsClient, flaky))),
      ),
    );
  });
});
