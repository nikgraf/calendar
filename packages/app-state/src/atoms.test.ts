import {
  Account,
  BackendError,
  type BackendClient,
  type EventRecord,
  GeoLocation,
} from '@calendar/core';
import { ACCOUNTS_KEY } from '@calendar/db/keys';
import { Effect } from 'effect';
import { AsyncResult, type Atom, AtomRegistry } from 'effect/unstable/reactivity';
import { describe, expect, it } from 'vitest';
import { makeBackendAtoms, mapSnapshotKey, rangeKey } from './atoms.ts';

const account = new Account({
  contactsEnabled: false,
  createdAt: 1,
  email: 'nik@example.com',
  id: 'acc-1',
  provider: 'google',
  status: 'ok',
  tasksEnabled: false,
});

const fail = (message: string) => Effect.fail(new BackendError({ message, tag: 'Stub' }));

const makeStubClient = () => {
  const calls = {
    accounts: 0,
    events: 0,
    places: [] as Array<string>,
    resolved: [] as Array<string>,
    setVisible: 0,
    snapshots: [] as Array<unknown>,
  };
  const client: BackendClient = {
    addAccount: () => fail('not stubbed'),
    clearLocationCache: () => Effect.void,
    completeTask: () => Effect.void,
    connectAppleCalendar: () => fail('not stubbed'),
    connectContacts: () => fail('not stubbed'),
    connectReminders: () => fail('not stubbed'),
    createEvent: () => fail('not stubbed'),
    createTask: () => fail('not stubbed'),
    deleteEvent: () => fail('not stubbed'),
    deleteRecurring: () => fail('not stubbed'),
    deleteTask: () => Effect.void,
    discardPendingOp: () => Effect.void,
    getBirthdayReminderSettings: () =>
      Effect.succeed({ enabled: false, leadDays: [0 as const], time: '09:00' }),
    getBirthdaysInRange: () => Effect.succeed([]),
    getEventNotificationSettings: () =>
      Effect.succeed({ enabled: true, includeAppleCalendar: false }),
    getEventsInRange: () =>
      Effect.sync(() => {
        calls.events += 1;
        return [] as ReadonlyArray<EventRecord>;
      }),
    getOverdueTasks: () => Effect.succeed([]),
    getTasksInRange: () => Effect.succeed([]),
    getViewPreferences: () => Effect.succeed({ allDayLaneCollapsed: false }),
    listAccounts: () =>
      Effect.sync(() => {
        calls.accounts += 1;
        return [account];
      }),
    listCalendars: () => Effect.succeed([]),
    listPendingOps: () => Effect.succeed([]),
    listSyncStatus: () => Effect.succeed([]),
    listTaskLists: () => Effect.succeed([]),
    mapSnapshot: (params) =>
      Effect.sync(() => {
        calls.snapshots.push(params);
        return { pngBase64: 'png' };
      }),
    moveEvent: () => fail('not stubbed'),
    moveTask: () => fail('not stubbed'),
    previewMove: () => fail('not stubbed'),
    removeAccount: () => Effect.void,
    resolveLocation: ({ location }) =>
      Effect.sync(() => {
        calls.resolved.push(location);
        return new GeoLocation({ lat: 1, lng: 2, source: location });
      }),
    respondToEvent: () => Effect.void,
    searchContacts: () => Effect.succeed([]),
    searchPlaces: ({ query }) =>
      Effect.sync(() => {
        calls.places.push(query);
        return [{ title: query }];
      }),
    setBirthdayReminderSettings: () => Effect.succeed({ notificationsGranted: true }),
    setCalendarColor: () => Effect.void,
    setCalendarVisible: () =>
      Effect.sync(() => {
        calls.setVisible += 1;
      }),
    setEventNotificationSettings: () => Effect.succeed({ notificationsGranted: true }),
    setTaskListVisible: () => Effect.void,
    setViewPreferences: () => Effect.void,
    syncNow: () => Effect.void,
    updateEvent: () => fail('not stubbed'),
    updateRecurring: () => fail('not stubbed'),
    updateTask: () => Effect.void,
  };
  return { calls, client };
};

const waitFor = async <A>(
  read: () => AsyncResult.AsyncResult<A, unknown>,
  predicate: (result: AsyncResult.AsyncResult<A, unknown>) => boolean,
): Promise<AsyncResult.AsyncResult<A, unknown>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = read();
    if (predicate(result)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
};

describe('backend atoms', () => {
  it('read atoms resolve through the runtime', async () => {
    const { calls, client } = makeStubClient();
    const atoms = makeBackendAtoms(client);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atoms.accounts);

    const result = await waitFor(() => registry.get(atoms.accounts), AsyncResult.isSuccess);
    expect(AsyncResult.getOrThrow(result)).toEqual([account]);
    expect(calls.accounts).toBe(1);
    unmount();
    registry.dispose();
  });

  it('a mutation fn with reactivityKeys refreshes read atoms (shared Reactivity)', async () => {
    const { calls, client } = makeStubClient();
    const atoms = makeBackendAtoms(client);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atoms.accounts);
    await waitFor(() => registry.get(atoms.accounts), AsyncResult.isSuccess);
    expect(calls.accounts).toBe(1);

    // setCalendarVisible invalidates CALENDARS_KEY + EVENTS_KEY, not accounts.
    registry.set(atoms.mutations.setCalendarVisible, {
      accountId: 'acc-1',
      calendarId: 'cal-1',
      isVisible: false,
    });
    await waitFor(
      () => registry.get(atoms.mutations.setCalendarVisible),
      (result) => !AsyncResult.isInitial(result),
    );
    expect(calls.accounts).toBe(1); // untouched — fine-grained keys work

    // addAccount invalidates ACCOUNTS_KEY → accounts refetches.
    registry.set(atoms.mutations.removeAccount, { accountId: 'acc-1' });
    await waitFor(
      () => registry.get(atoms.accounts),
      () => calls.accounts >= 2,
    );
    expect(calls.accounts).toBe(2);
    unmount();
    registry.dispose();
  });

  it('a color change leaves mounted ranges alone; a visibility toggle refetches them', async () => {
    const { calls, client } = makeStubClient();
    const atoms = makeBackendAtoms(client);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atoms.eventsInRange(rangeKey(0, 1)));
    await waitFor(() => registry.get(atoms.eventsInRange(rangeKey(0, 1))), AsyncResult.isSuccess);
    expect(calls.events).toBe(1);

    registry.set(atoms.mutations.setCalendarColor, {
      accountId: 'acc-1',
      calendarId: 'cal-1',
      colorHex: '#123456',
    });
    await waitFor(
      () => registry.get(atoms.mutations.setCalendarColor),
      (result) => !AsyncResult.isInitial(result) && !AsyncResult.isWaiting(result),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.events).toBe(1);

    registry.set(atoms.mutations.setCalendarVisible, {
      accountId: 'acc-1',
      calendarId: 'cal-1',
      isVisible: false,
    });
    await waitFor(
      () => registry.get(atoms.eventsInRange(rangeKey(0, 1))),
      () => calls.events >= 2,
    );
    expect(calls.events).toBe(2);
    unmount();
    registry.dispose();
  });

  it('bindInvalidations feeds external keys into the runtime reactivity', async () => {
    const { calls, client } = makeStubClient();
    const atoms = makeBackendAtoms(client);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atoms.accounts);
    await waitFor(() => registry.get(atoms.accounts), AsyncResult.isSuccess);

    let emit: ((keys: ReadonlyArray<unknown>) => void) | undefined;
    const unbind = atoms.bindInvalidations(registry, (listener) => {
      emit = listener;
      return () => {
        emit = undefined;
      };
    });
    // The accessor atom resolves asynchronously; wait until wired.
    await new Promise((resolve) => setTimeout(resolve, 20));

    emit?.([ACCOUNTS_KEY]);
    await waitFor(
      () => registry.get(atoms.accounts),
      () => calls.accounts >= 2,
    );
    expect(calls.accounts).toBe(2);

    unbind();
    unmount();
    registry.dispose();
  });

  it('eventsInRange family memoizes atoms per range key', () => {
    const { client } = makeStubClient();
    const atoms = makeBackendAtoms(client);
    const key = rangeKey(1000, 2000);
    expect(atoms.eventsInRange(key)).toBe(atoms.eventsInRange(key));
    expect(atoms.eventsInRange(key)).not.toBe(atoms.eventsInRange(rangeKey(2000, 3000)));
  });
});

describe('eventsInRange LRU', () => {
  it('memoizes per key and evicts the least-recently-used range', () => {
    const { client } = makeStubClient();
    const atoms = makeBackendAtoms(client);
    const first = atoms.eventsInRange('0:100');
    expect(atoms.eventsInRange('0:100')).toBe(first);

    // Fill the cache past its limit while touching the first key midway.
    for (let index = 0; index < 20; index += 1) {
      atoms.eventsInRange(`${index}:a`);
    }
    expect(atoms.eventsInRange('0:100')).toBe(first);
    for (let index = 0; index < 40; index += 1) {
      atoms.eventsInRange(`${index}:b`);
    }
    // Now it has been evicted: a fresh atom object is created.
    expect(atoms.eventsInRange('0:100')).not.toBe(first);
  });

  it('location atoms answer empty keys locally and pass the rest through', async () => {
    const { calls, client } = makeStubClient();
    const atoms = makeBackendAtoms(client);
    const registry = AtomRegistry.make();
    const unmounts: Array<() => void> = [];
    const settle = async <A>(atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>): Promise<A> => {
      unmounts.push(registry.mount(atom));
      return AsyncResult.getOrThrow(await waitFor(() => registry.get(atom), AsyncResult.isSuccess));
    };
    const params = {
      appearance: 'dark' as const,
      height: 160,
      lat: 48.2,
      lng: 16.37,
      scale: 2,
      width: 372,
    };

    expect(await settle(atoms.placesSearch('6:'))).toEqual([]);
    expect(await settle(atoms.placesSearch('6:naschmarkt'))).toEqual([{ title: 'naschmarkt' }]);
    expect(await settle(atoms.locationGeo(''))).toBeNull();
    expect((await settle(atoms.locationGeo('Naschmarkt')))?.source).toBe('Naschmarkt');
    expect(await settle(atoms.mapSnapshot(''))).toBeNull();
    expect(await settle(atoms.mapSnapshot(mapSnapshotKey(params)))).toBe('png');

    expect(calls.places).toEqual(['naschmarkt']);
    expect(calls.resolved).toEqual(['Naschmarkt']);
    expect(calls.snapshots).toEqual([params]);
    for (const unmount of unmounts) {
      unmount();
    }
    registry.dispose();
  });
});
