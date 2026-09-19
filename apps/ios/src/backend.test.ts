import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  contacts: vi.fn<() => Promise<boolean>>(),
  reminders: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('expo-secure-store', () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));
vi.mock('./googleAuth.ts', () => ({ signInWithGoogle: vi.fn() }));
vi.mock('./notifications.ts', async () => {
  const { noopNotificationSink, NotificationSink } = await import('@calendar/sync');
  return { iosNotificationSink: Layer.succeed(NotificationSink, noopNotificationSink) };
});
vi.mock('@effect/sql-sqlite-react-native/SqliteClient', async () => {
  const { SqlClient } = await import('effect/unstable/sql/SqlClient');
  return {
    layer: () => Layer.effect(SqlClient)(Effect.die(new Error('Database is ahead of this build'))),
  };
});
vi.mock('./contactsClient.ts', async () => {
  const { ContactsClient, ContactsRequestError, makeFakeContactsClient } =
    await import('@calendar/contacts');
  const client = {
    ...makeFakeContactsClient().client,
    requestAccess: () =>
      Effect.tryPromise({
        catch: (error) =>
          new ContactsRequestError({ message: String(error), method: 'contacts.requestAccess' }),
        try: () => native.contacts(),
      }),
  };
  return { iosContactsClient: client, iosContactsLayer: Layer.succeed(ContactsClient, client) };
});
vi.mock('./geoClient.ts', async () => {
  const { GeoClient, unavailableGeoClient } = await import('@calendar/geo');
  return { iosGeoLayer: Layer.succeed(GeoClient, unavailableGeoClient('test')) };
});
vi.mock('./remindersClient.ts', async () => {
  const { makeFakeRemindersClient, RemindersClient, RemindersRequestError } =
    await import('@calendar/reminders');
  const client = {
    ...makeFakeRemindersClient().client,
    requestAccess: () =>
      Effect.tryPromise({
        catch: (error) =>
          new RemindersRequestError({ message: String(error), method: 'reminders.requestAccess' }),
        try: () => native.reminders(),
      }),
  };
  return { iosRemindersClient: client, iosRemindersLayer: Layer.succeed(RemindersClient, client) };
});

const { backendClient } = await import('./backend.ts');

beforeEach(() => {
  native.contacts.mockReset();
  native.reminders.mockReset();
});

describe.each([
  ['Contacts', 'connectContacts', native.contacts],
  ['Reminders', 'connectReminders', native.reminders],
] as const)('%s connection', (_label, method, requestAccess) => {
  it('asks the OS before backend initialization, preserving a later startup error', async () => {
    requestAccess.mockResolvedValue(true);
    const result = await Effect.runPromise(Effect.result(backendClient[method](undefined)));
    expect(requestAccess).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { message: expect.stringContaining('Database is ahead of this build') },
    });
  });

  it('returns an actual denial without starting the broken backend', async () => {
    requestAccess.mockResolvedValue(false);
    await expect(Effect.runPromise(backendClient[method](undefined))).resolves.toEqual({
      granted: false,
    });
    expect(requestAccess).toHaveBeenCalledOnce();
  });

  it('preserves permission-request errors instead of reporting a denial', async () => {
    requestAccess.mockRejectedValue(new Error('Native permission request failed'));
    const result = await Effect.runPromise(Effect.result(backendClient[method](undefined)));
    expect(requestAccess).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { message: expect.stringContaining('Native permission request failed') },
    });
  });
});
