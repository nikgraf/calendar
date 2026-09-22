import {
  ContactsClient,
  ContactsRequestError,
  makeFakeContactsClient,
  type ContactsClientShape,
} from '@calendar/contacts';
import { Account, APPLE_REMINDERS_ACCOUNT_ID, type BirthdayReminderSettings } from '@calendar/core';
import { AccountRepo, DeviceSettingsRepo, runMigrations } from '@calendar/db';
import {
  makeFakeRemindersClient,
  RemindersClient,
  RemindersRequestError,
  type RemindersClientShape,
} from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe, vi } from 'vitest';
import { commonBackendHandlers } from './backendHandlers.ts';
import { LocalNotifications } from './localNotifications.ts';
import { DeviceContacts } from './deviceContacts.ts';
import { SyncEngine } from './engine.ts';
import { NotificationSink, type NotificationSinkShape } from './notificationSink.ts';

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

const setBirthdayReminderSettings = (settings: BirthdayReminderSettings) =>
  commonBackendHandlers.setBirthdayReminderSettings(settings) as Effect.Effect<
    { readonly notificationsGranted: boolean },
    unknown,
    DeviceSettingsRepo | LocalNotifications | NotificationSink
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

const birthdaySetup = (kind: 'immediate' | 'scheduled', granted = true) => {
  const ensurePermission = vi.fn(() => Effect.succeed(granted));
  const sink: NotificationSinkShape =
    kind === 'immediate'
      ? { ensurePermission, kind, show: () => Effect.void }
      : { ensurePermission, kind, replaceSchedule: () => Effect.void };
  const layer = Layer.mergeAll(
    DeviceSettingsRepo.layer.pipe(
      Layer.provideMerge(Layer.effectDiscard(runMigrations)),
      Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
      Layer.provideMerge(reactivityLayer),
    ),
    Layer.succeed(NotificationSink, sink),
    Layer.succeed(LocalNotifications, { run: () => Effect.void, start: () => Effect.void }),
  );
  return { ensurePermission, layer };
};

describe('setBirthdayReminderSettings', () => {
  const on: BirthdayReminderSettings = { enabled: true, leadDays: [0], time: '09:00' };

  it.effect('an immediate sink is asked once, as the reminders turn on', () => {
    const { ensurePermission, layer } = birthdaySetup('immediate');
    return Effect.gen(function* () {
      expect(yield* setBirthdayReminderSettings(on)).toEqual({ notificationsGranted: true });
      expect(yield* setBirthdayReminderSettings({ ...on, leadDays: [0, 1] })).toEqual({
        notificationsGranted: true,
      });
      expect(ensurePermission).toHaveBeenCalledOnce();
      yield* setBirthdayReminderSettings({ ...on, enabled: false });
      yield* setBirthdayReminderSettings(on);
      expect(ensurePermission).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect('a declined immediate sink reports notifications off', () => {
    const { layer } = birthdaySetup('immediate', false);
    return Effect.gen(function* () {
      expect(yield* setBirthdayReminderSettings(on)).toEqual({ notificationsGranted: false });
    }).pipe(Effect.provide(layer));
  });

  it.effect('a scheduled sink is asked on every enabled save', () => {
    const { ensurePermission, layer } = birthdaySetup('scheduled');
    return Effect.gen(function* () {
      yield* setBirthdayReminderSettings(on);
      yield* setBirthdayReminderSettings({ ...on, time: '08:00' });
      expect(ensurePermission).toHaveBeenCalledTimes(2);
      yield* setBirthdayReminderSettings({ ...on, enabled: false });
      expect(ensurePermission).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer));
  });
});
