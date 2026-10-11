import {
  Account,
  BackendError,
  type BackendClient,
  EMPTY_SEARCH_RESULTS,
  type EventRecord,
  GeoLocation,
} from '@calendar/core';
import { ACCOUNTS_KEY } from '@calendar/db/keys';
import { Effect } from 'effect';
import { AsyncResult, Atom, AtomRegistry } from 'effect/reactivity';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  deviceZoneAtom,
  makeBackendAtoms,
  mapSnapshotKey,
  rangeKey,
  runMutation,
  searchKey,
} from './atoms.ts';

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
    searches: [] as Array<{ readonly query: string; readonly timeZone: string }>,
    setVisible: 0,
    snapshots: [] as Array<unknown>,
    timeZones: 0,
  };
  const client: BackendClient = {
    addAccount: () => fail('not stubbed'),
    clearLocationCache: () => Effect.void,
    completeTask: () => Effect.void,
    connectAppleCalendar: () => fail('not stubbed'),
    connectContacts: () => fail('not stubbed'),
    connectReminders: () => fail('not stubbed'),
    convertEventToTask: () => fail('not stubbed'),
    convertTaskToEvent: () => fail('not stubbed'),
    createEvent: () => fail('not stubbed'),
    createMirrorCalendar: () => fail('not stubbed'),
    createTask: () => fail('not stubbed'),
    deleteEvent: () => fail('not stubbed'),
    deleteMirror: () => fail('not stubbed'),
    deleteRecurring: () => fail('not stubbed'),
    deleteTask: () => Effect.void,
    discardPendingOp: () => Effect.void,
    exportSettings: () => Effect.succeed({ version: 1 as const }),
    getBirthdayReminderOverrides: () => Effect.succeed([]),
    getBirthdayReminderSettings: () =>
      Effect.succeed({ enabled: false, leadDays: [0 as const], time: '09:00' }),
    getBirthdaysInRange: () => Effect.succeed([]),
    getEvent: () => Effect.succeed(null),
    getEventNotificationSettings: () =>
      Effect.succeed({ enabled: true, includeAppleCalendar: false }),
    getEventsInRange: () =>
      Effect.sync(() => {
        calls.events += 1;
        return [] as ReadonlyArray<EventRecord>;
      }),
    getOverdueTasks: () => Effect.succeed([]),
    getTasksInRange: () => Effect.succeed([]),
    getTimeZoneSettings: () =>
      Effect.sync(() => {
        calls.timeZones += 1;
        return { primary: 'device', zones: ['device'] };
      }),
    getViewPreferences: () => Effect.succeed({ allDayLaneCollapsed: false }),
    importSettings: () => fail('not stubbed'),
    listAccounts: () =>
      Effect.sync(() => {
        calls.accounts += 1;
        return [account];
      }),
    listCalendars: () => Effect.succeed([]),
    listMirrors: () => Effect.succeed([]),
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
    previewEventToTask: () => fail('not stubbed'),
    previewMirror: () => fail('not stubbed'),
    previewMove: () => fail('not stubbed'),
    previewSettingsImport: () => fail('not stubbed'),
    removeAccount: () => Effect.void,
    resolveConflict: () => Effect.void,
    resolveLocation: ({ location }) =>
      Effect.sync(() => {
        calls.resolved.push(location);
        return new GeoLocation({ lat: 1, lng: 2, source: location });
      }),
    respondToEvent: () => Effect.void,
    runMirrorsNow: () => Effect.void,
    saveMirror: () => fail('not stubbed'),
    search: (params) =>
      Effect.sync(() => {
        calls.searches.push(params);
        return EMPTY_SEARCH_RESULTS;
      }),
    searchContacts: () => Effect.succeed([]),
    searchPlaces: ({ query }) =>
      Effect.sync(() => {
        calls.places.push(query);
        return [{ title: query }];
      }),
    setBirthdayReminderOverride: () => Effect.void,
    setBirthdayReminderSettings: () => Effect.succeed({ notificationsGranted: true }),
    setCalendarColor: () => Effect.void,
    setCalendarVisible: () =>
      Effect.sync(() => {
        calls.setVisible += 1;
      }),
    setEventNotificationSettings: () => Effect.succeed({ notificationsGranted: true }),
    setMirrorEnabled: () => fail('not stubbed'),
    setTaskListVisible: () => Effect.void,
    setTimeZoneSettings: () => Effect.void,
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
    const visible = atoms.mutationCall('setCalendarVisible');
    registry.set(visible, {
      accountId: 'acc-1',
      calendarId: 'cal-1',
      isVisible: false,
    });
    await waitFor(
      () => registry.get(visible),
      (result) => !AsyncResult.isInitial(result),
    );
    expect(calls.accounts).toBe(1); // untouched — fine-grained keys work

    // addAccount invalidates ACCOUNTS_KEY → accounts refetches.
    registry.set(atoms.mutationCall('removeAccount'), { accountId: 'acc-1' });
    await waitFor(
      () => registry.get(atoms.accounts),
      () => calls.accounts >= 2,
    );
    expect(calls.accounts).toBe(2);
    unmount();
    registry.dispose();
  });

  it('two quick calls of one mutation both run, each to its own result', async () => {
    const { client } = makeStubClient();
    const finished: Array<string> = [];
    // The first drag's write is the slower one: a second call used to
    // interrupt it, and both callers read the second's result.
    const slow: BackendClient = {
      ...client,
      previewMove: (params) =>
        Effect.gen(function* () {
          yield* Effect.sleep(params.eventId === 'first' ? '30 millis' : '5 millis');
          finished.push(params.eventId);
          return {
            attendees: params.eventId === 'first' ? 1 : 2,
            emailReminders: 0,
            meetingLink: false,
            modifiedOccurrences: 0,
            unsupportedRuleParts: [],
          };
        }),
    };
    const atoms = makeBackendAtoms(slow);
    const registry = AtomRegistry.make();
    const call = (eventId: string) =>
      runMutation(registry, atoms, 'previewMove', {
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId,
        target: { accountId: 'acc-1', calendarId: 'cal-2' },
      });
    const [first, second] = await Promise.all([call('first'), call('second')]);
    expect([first.attendees, second.attendees]).toEqual([1, 2]);
    expect(finished.sort()).toEqual(['first', 'second']);
    registry.dispose();
  });

  it('a color change leaves mounted ranges alone; a visibility toggle refetches them', async () => {
    const { calls, client } = makeStubClient();
    const atoms = makeBackendAtoms(client);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atoms.eventsInRange(rangeKey(0, 1)));
    await waitFor(() => registry.get(atoms.eventsInRange(rangeKey(0, 1))), AsyncResult.isSuccess);
    expect(calls.events).toBe(1);

    const color = atoms.mutationCall('setCalendarColor');
    registry.set(color, {
      accountId: 'acc-1',
      calendarId: 'cal-1',
      colorHex: '#123456',
    });
    await waitFor(
      () => registry.get(color),
      (result) => !AsyncResult.isInitial(result) && !AsyncResult.isWaiting(result),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.events).toBe(1);

    registry.set(atoms.mutationCall('setCalendarVisible'), {
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

describe('search atoms', () => {
  it('pass the query and zone through, answer a blank query locally, and memoize per key', async () => {
    const { calls, client } = makeStubClient();
    const atoms = makeBackendAtoms(client);
    const registry = AtomRegistry.make();
    const blank = atoms.search(searchKey('  ', 'Europe/Vienna'));
    const lunch = atoms.search(searchKey('lunch | café', 'Europe/Vienna'));
    expect(atoms.search(searchKey('lunch | café', 'Europe/Vienna'))).toBe(lunch);
    const unmounts = [registry.mount(blank), registry.mount(lunch)];
    expect(
      AsyncResult.getOrThrow(await waitFor(() => registry.get(blank), AsyncResult.isSuccess)),
    ).toEqual(EMPTY_SEARCH_RESULTS);
    await waitFor(() => registry.get(lunch), AsyncResult.isSuccess);
    expect(calls.searches).toEqual([{ query: 'lunch | café', timeZone: 'Europe/Vienna' }]);
    for (const unmount of unmounts) {
      unmount();
    }
    registry.dispose();
  });

  it('a blank search answers locally and does not re-run on changes', async () => {
    const { client } = makeStubClient();
    const atoms = makeBackendAtoms(client);
    const registry = AtomRegistry.make();
    const blank = atoms.search(searchKey('', 'UTC'));
    const seen: Array<unknown> = [];
    const unsubscribe = registry.subscribe(blank, (value) => seen.push(value), {
      immediate: true,
    });
    await waitFor(() => registry.get(blank), AsyncResult.isSuccess);
    const settled = seen.length;
    await runMutation(registry, atoms, 'deleteTask', {
      accountId: 'acc-1',
      taskId: 'task-1',
      taskListId: 'list-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(settled);
    unsubscribe();
    registry.dispose();
  });

  it('a mounted search re-runs when an event or a task changes', async () => {
    const { calls, client } = makeStubClient();
    const atoms = makeBackendAtoms(client);
    const registry = AtomRegistry.make();
    const atom = atoms.search(searchKey('lunch', 'UTC'));
    const unmount = registry.mount(atom);
    await waitFor(() => registry.get(atom), AsyncResult.isSuccess);
    expect(calls.searches).toHaveLength(1);

    // Deleting a task invalidates TASKS_KEY.
    await runMutation(registry, atoms, 'deleteTask', {
      accountId: 'acc-1',
      taskId: 'task-1',
      taskListId: 'list-1',
    });
    await waitFor(
      () => registry.get(atom),
      () => calls.searches.length >= 2,
    );
    // Showing or hiding a calendar invalidates EVENTS_KEY.
    await runMutation(registry, atoms, 'setCalendarVisible', {
      accountId: 'acc-1',
      calendarId: 'cal-1',
      isVisible: false,
    });
    await waitFor(
      () => registry.get(atom),
      () => calls.searches.length >= 3,
    );
    expect(calls.searches).toHaveLength(3);
    unmount();
    registry.dispose();
  });
});

describe('device zone', () => {
  it('is read again each interval and changes only when the zone does', () => {
    vi.useFakeTimers();
    try {
      let zone = 'Europe/Vienna';
      const atom = deviceZoneAtom(() => zone, 1000);
      const registry = AtomRegistry.make();
      const seen: Array<string> = [];
      const unsubscribe = registry.subscribe(atom, (value) => seen.push(value), {
        immediate: true,
      });

      vi.advanceTimersByTime(3000);
      expect(seen).toEqual(['Europe/Vienna']);

      zone = 'America/New_York';
      vi.advanceTimersByTime(1000);
      expect(registry.get(atom)).toBe('America/New_York');
      expect(seen).toEqual(['Europe/Vienna', 'America/New_York']);

      unsubscribe();
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a device zone change does not refetch the time zones: the stored entries resolve against it', async () => {
    const { calls, client } = makeStubClient();
    const deviceZone = Atom.make('Europe/Vienna');
    const atoms = makeBackendAtoms(client, deviceZone);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atoms.timeZoneSettings);
    await waitFor(() => registry.get(atoms.timeZoneSettings), AsyncResult.isSuccess);
    expect(calls.timeZones).toBe(1);

    registry.set(deviceZone, 'America/New_York');
    expect(registry.get(atoms.deviceZone)).toBe('America/New_York');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.timeZones).toBe(1);
    unmount();
    registry.dispose();
  });
});
