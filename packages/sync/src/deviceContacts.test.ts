import {
  ContactsClient,
  type ContactsClientShape,
  ContactsRequestError,
  makeFakeContactsClient,
} from '@calendar/contacts';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { DeviceContacts } from './deviceContacts.ts';

const alice = { contactId: 'c1', displayName: 'Alice', email: 'alice@example.com' };

/** Gives every other runnable fiber a turn. */
const settle = Effect.forEach(Array.from({ length: 5 }), () => Effect.yieldNow, { discard: true });

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
        DeviceContacts.layer.pipe(
          Layer.provide(Layer.succeed(ContactsClient, client)),
          Layer.provide(reactivityLayer),
        ),
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
        DeviceContacts.layer.pipe(
          Layer.provide(Layer.succeed(ContactsClient, flaky)),
          Layer.provide(reactivityLayer),
        ),
      ),
    );
  });

  it.effect(
    'birthdays ride the same snapshot, and an old bridge without the method keeps the last list',
    () => {
      const { client, state } = makeFakeContactsClient({
        birthdays: [
          { contactId: 'c1', day: 4, displayName: 'Alice', month: 3, year: 1994 },
          { contactId: 'c2', day: 1, month: 1 },
        ],
        contacts: [alice],
      });
      let legacy = false;
      const bridge: ContactsClientShape = {
        ...client,
        birthdays: () =>
          legacy
            ? Effect.fail(
                new ContactsRequestError({
                  message: 'unknown contacts method: contacts.birthdays',
                  method: 'birthdays',
                }),
              )
            : client.birthdays(),
      };
      return Effect.gen(function* () {
        const contacts = yield* DeviceContacts;
        const birthdays = yield* contacts.birthdays();
        // One bridge round trip serves both lists; a nameless row is skipped.
        expect(birthdays.map((record) => [record.id, record.displayName, record.year])).toEqual([
          ['device:c1', 'Alice', 1994],
        ]);
        expect(state.calls.filter((call) => call === 'snapshot')).toHaveLength(1);
        expect(state.calls.filter((call) => call === 'birthdays')).toHaveLength(1);
        expect(yield* contacts.list()).toHaveLength(1);
        expect(state.calls.filter((call) => call === 'snapshot')).toHaveLength(1);

        legacy = true;
        yield* TestClock.adjust('6 minutes');
        expect((yield* contacts.birthdays()).map((record) => record.id)).toEqual(['device:c1']);
        expect(yield* contacts.list()).toHaveLength(1);
      }).pipe(
        Effect.provide(
          DeviceContacts.layer.pipe(
            Layer.provide(Layer.succeed(ContactsClient, bridge)),
            Layer.provide(reactivityLayer),
          ),
        ),
      );
    },
  );

  it.effect('a change notification refreshes the birthdays', () => {
    const { client, state } = makeFakeContactsClient({ contacts: [alice] });
    return Effect.gen(function* () {
      const contacts = yield* DeviceContacts;
      expect(yield* contacts.birthdays()).toEqual([]);
      state.birthdays.push({ contactId: 'c1', day: 4, displayName: 'Alice', month: 3 });
      // The change stream is consumed on a forked fiber: let it subscribe
      // before the notification fires, let it take the element before the
      // debounce timer is advanced, and let the refresh finish after.
      yield* settle;
      state.emitChange();
      yield* settle;
      yield* TestClock.adjust('3 seconds');
      yield* settle;
      expect((yield* contacts.birthdays()).map((record) => record.displayName)).toEqual(['Alice']);
    }).pipe(
      Effect.provide(
        DeviceContacts.layer.pipe(
          Layer.provide(Layer.succeed(ContactsClient, client)),
          Layer.provide(reactivityLayer),
        ),
      ),
    );
  });
});
