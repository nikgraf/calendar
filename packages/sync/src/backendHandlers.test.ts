import {
  ContactsClient,
  ContactsRequestError,
  makeFakeContactsClient,
  type ContactsClientShape,
} from '@calendar/contacts';
import { Account, APPLE_REMINDERS_ACCOUNT_ID } from '@calendar/core';
import { AccountRepo, runMigrations } from '@calendar/db';
import {
  makeFakeRemindersClient,
  RemindersClient,
  RemindersRequestError,
  type RemindersClientShape,
} from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe, vi } from 'vitest';
import { commonBackendHandlers } from './backendHandlers.ts';
import { DeviceContacts } from './deviceContacts.ts';
import { SyncEngine } from './engine.ts';

// The exported handler map widens each method to all backend services.
// These tests intentionally supply only the services these two paths use:
// an unexpected dependency fails at runtime instead of hiding in a full app.
const connectReminders = commonBackendHandlers.connectReminders(undefined) as Effect.Effect<
  { readonly granted: boolean },
  unknown,
  AccountRepo | RemindersClient | SyncEngine
>;
const connectContacts = commonBackendHandlers.connectContacts(undefined) as Effect.Effect<
  { readonly granted: boolean },
  unknown,
  ContactsClient | DeviceContacts
>;

const remindersSetup = (client: RemindersClientShape) => {
  const syncAll = vi.fn(() => Effect.void);
  const layer = Layer.mergeAll(
    AccountRepo.layer.pipe(
      Layer.provideMerge(Layer.effectDiscard(runMigrations)),
      Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
      Layer.provideMerge(reactivityLayer),
    ),
    Layer.succeed(RemindersClient, client),
    Layer.succeed(SyncEngine, { start: () => Effect.void, syncAll }),
  );
  return { layer, syncAll };
};

const contactsSetup = (client: ContactsClientShape) => {
  const refresh = vi.fn(() => Effect.void);
  const layer = Layer.mergeAll(
    Layer.succeed(ContactsClient, client),
    Layer.succeed(DeviceContacts, {
      birthdays: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
      refresh,
    }),
  );
  return { layer, refresh };
};

describe('connectReminders', () => {
  it.effect('requests first access and provisions the Apple account before syncing', () => {
    const { client, state } = makeFakeRemindersClient({ authorization: 'notDetermined' });
    const { layer, syncAll } = remindersSetup(client);
    return Effect.gen(function* () {
      expect(yield* connectReminders).toEqual({ granted: true });
      expect(state.calls).toContain('requestAccess');
      expect(yield* (yield* AccountRepo).list()).toMatchObject([
        {
          contactsEnabled: false,
          displayName: 'Apple Reminders',
          id: APPLE_REMINDERS_ACCOUNT_ID,
          provider: 'apple',
          status: 'ok',
          tasksEnabled: true,
        },
      ]);
      expect(syncAll).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer));
  });

  it.effect('waits for the grant to be visible before creating the account and syncing', () => {
    const { client, state } = makeFakeRemindersClient({ authorization: 'notDetermined' });
    // The prompt was answered, but the status still reads notDetermined.
    const requestAccess = vi.fn(() => Effect.succeed(true));
    const { layer, syncAll } = remindersSetup({ ...client, requestAccess });
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(connectReminders);
      yield* TestClock.adjust('3 seconds');
      expect(yield* (yield* AccountRepo).list()).toEqual([]);
      expect(syncAll).not.toHaveBeenCalled();
      state.authorization = 'fullAccess';
      yield* TestClock.adjust('1 second');
      expect(yield* Fiber.join(fiber)).toEqual({ granted: true });
      expect(yield* (yield* AccountRepo).list()).toMatchObject([{ status: 'ok' }]);
      expect(syncAll).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer));
  });

  it.effect('a declined request creates no account and starts no sync', () => {
    const { client } = makeFakeRemindersClient({ authorization: 'notDetermined' });
    const requestAccess = vi.fn(() => Effect.succeed(false));
    const { layer, syncAll } = remindersSetup({ ...client, requestAccess });
    return Effect.gen(function* () {
      expect(yield* connectReminders).toEqual({ granted: false });
      expect(requestAccess).toHaveBeenCalledOnce();
      expect(yield* (yield* AccountRepo).list()).toEqual([]);
      expect(syncAll).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect('a native request failure remains an error and creates no account', () => {
    const { client } = makeFakeRemindersClient({ authorization: 'notDetermined' });
    const error = new RemindersRequestError({
      message: 'EventKit could not request permission',
      method: 'reminders.requestAccess',
    });
    const { layer, syncAll } = remindersSetup({
      ...client,
      requestAccess: () => Effect.fail(error),
    });
    return Effect.gen(function* () {
      const result = yield* Effect.result(connectReminders);
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure).toBe(error);
      }
      expect(yield* (yield* AccountRepo).list()).toEqual([]);
      expect(syncAll).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    'refreshes native access and reconnects the same account after an existing grant',
    () => {
      const { client, state } = makeFakeRemindersClient({ authorization: 'fullAccess' });
      const { layer, syncAll } = remindersSetup(client);
      return Effect.gen(function* () {
        const accounts = yield* AccountRepo;
        yield* accounts.upsert(
          new Account({
            contactsEnabled: false,
            createdAt: 123,
            email: '',
            id: APPLE_REMINDERS_ACCOUNT_ID,
            provider: 'apple',
            status: 'reauth_required',
            tasksEnabled: true,
          }),
        );
        expect(yield* connectReminders).toEqual({ granted: true });
        expect(state.calls).toContain('requestAccess');
        expect(yield* accounts.list()).toMatchObject([
          { createdAt: 123, id: APPLE_REMINDERS_ACCOUNT_ID, status: 'ok' },
        ]);
        expect(syncAll).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(layer));
    },
  );
});

describe('connectContacts', () => {
  it.effect('requests first access and refreshes device contacts after a grant', () => {
    const { client, state } = makeFakeContactsClient({ authorization: 'notDetermined' });
    const { layer, refresh } = contactsSetup(client);
    return Effect.gen(function* () {
      expect(yield* connectContacts).toEqual({ granted: true });
      expect(state.calls).toContain('requestAccess');
      expect(refresh).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer));
  });

  it.effect('a declined request does not read device contacts', () => {
    const { client } = makeFakeContactsClient({ authorization: 'notDetermined' });
    const requestAccess = vi.fn(() => Effect.succeed(false));
    const { layer, refresh } = contactsSetup({ ...client, requestAccess });
    return Effect.gen(function* () {
      expect(yield* connectContacts).toEqual({ granted: false });
      expect(requestAccess).toHaveBeenCalledOnce();
      expect(refresh).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect('a native request failure remains an error and does not read device contacts', () => {
    const { client } = makeFakeContactsClient({ authorization: 'notDetermined' });
    const error = new ContactsRequestError({
      message: 'Contacts could not request permission',
      method: 'contacts.requestAccess',
    });
    const { layer, refresh } = contactsSetup({
      ...client,
      requestAccess: () => Effect.fail(error),
    });
    return Effect.gen(function* () {
      const result = yield* Effect.result(connectContacts);
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure).toBe(error);
      }
      expect(refresh).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  for (const authorization of ['authorized', 'limited'] as const) {
    it.effect(`reuses ${authorization} access without asking again`, () => {
      const { client, state } = makeFakeContactsClient({ authorization });
      const { layer, refresh } = contactsSetup(client);
      return Effect.gen(function* () {
        expect(yield* connectContacts).toEqual({ granted: true });
        expect(state.calls).not.toContain('requestAccess');
        expect(refresh).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(layer));
    });
  }
});
