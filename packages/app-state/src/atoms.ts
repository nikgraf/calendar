import {
  ACCOUNTS_KEY,
  BIRTHDAYS_KEY,
  CALENDARS_KEY,
  CONTACTS_KEY,
  deviceSettingsKey,
  EVENTS_KEY,
  LOCATION_GEO_KEY,
  OPS_KEY,
  SYNC_STATE_KEY,
  TASKLISTS_KEY,
  TASKS_KEY,
} from '@calendar/db/keys';
import {
  type BackendClient,
  type BackendPayload,
  type BackendSuccess,
  Temporal,
} from '@calendar/core';
import { Cause, Context, Effect, Exit, Layer } from 'effect';
import { Atom, AsyncResult, AtomRegistry, Reactivity } from 'effect/reactivity';

/** The BackendClient as a service, so atom effects can yield it. */
export class AppBackend extends Context.Service<AppBackend, BackendClient>()(
  'app-state/AppBackend',
) {}

export const rangeKey = (rangeStartUtc: number, rangeEndUtc: number): string =>
  `${rangeStartUtc}:${rangeEndUtc}`;

export type MapSnapshotParams = BackendPayload<'mapSnapshot'>;

/** Atom key for a map image request; one key per image the UI can show. */
export const mapSnapshotKey = (params: MapSnapshotParams): string =>
  [params.appearance, params.width, params.height, params.scale, params.lat, params.lng].join('|');

const parseMapSnapshotKey = (key: string): MapSnapshotParams => {
  const [appearance, width, height, scale, lat, lng] = key.split('|');
  return {
    appearance: appearance === 'dark' ? 'dark' : 'light',
    height: Number(height),
    lat: Number(lat),
    lng: Number(lng),
    scale: Number(scale),
    width: Number(width),
  };
};

/** The mirror definitions' and their device-local status rows' settings keys (see sync/mirrorSettings.ts). */
const MIRRORS_KEYS = deviceSettingsKey('mirrors');
const MIRRORS_LOCAL_KEY = deviceSettingsKey('mirrors.local');
/** Per-person birthday lead days (see sync/deviceSettings.ts). */
const BIRTHDAY_OVERRIDES_KEY = deviceSettingsKey('birthdayReminderOverrides');

export interface BackendAtoms {
  readonly accounts: ReturnType<typeof buildAtoms>['accounts'];
  readonly bindInvalidations: (
    registry: AtomRegistry.AtomRegistry,
    subscribe: (listener: (keys: ReadonlyArray<unknown>) => void) => () => void,
  ) => () => void;
  readonly birthdayReminderOverrides: ReturnType<typeof buildAtoms>['birthdayReminderOverrides'];
  readonly birthdayReminderSettings: ReturnType<typeof buildAtoms>['birthdayReminderSettings'];
  readonly birthdaysInRange: ReturnType<typeof buildAtoms>['birthdaysInRange'];
  readonly calendars: ReturnType<typeof buildAtoms>['calendars'];
  readonly contactsSearch: ReturnType<typeof buildAtoms>['contactsSearch'];
  readonly eventById: ReturnType<typeof buildAtoms>['eventById'];
  readonly eventNotificationSettings: ReturnType<typeof buildAtoms>['eventNotificationSettings'];
  readonly eventsInRange: ReturnType<typeof buildAtoms>['eventsInRange'];
  readonly locationGeo: ReturnType<typeof buildAtoms>['locationGeo'];
  readonly mapSnapshot: ReturnType<typeof buildAtoms>['mapSnapshot'];
  readonly mirrors: ReturnType<typeof buildAtoms>['mirrors'];
  readonly mutationCall: ReturnType<typeof buildAtoms>['mutationCall'];
  readonly overdueTasks: ReturnType<typeof buildAtoms>['overdueTasks'];
  readonly pendingOps: ReturnType<typeof buildAtoms>['pendingOps'];
  readonly placesSearch: ReturnType<typeof buildAtoms>['placesSearch'];
  readonly syncStatus: ReturnType<typeof buildAtoms>['syncStatus'];
  readonly taskLists: ReturnType<typeof buildAtoms>['taskLists'];
  readonly tasksInRange: ReturnType<typeof buildAtoms>['tasksInRange'];
  readonly timeZoneSettings: ReturnType<typeof buildAtoms>['timeZoneSettings'];
  readonly viewPreferences: ReturnType<typeof buildAtoms>['viewPreferences'];
}

/**
 * The UI-runtime Reactivity keys each mutation invalidates — the single
 * source for which mutation atoms exist (the atoms record is derived from
 * these entries). Keys chosen per method; syncNow is empty because the
 * backend invalidates through the bridge as sync data lands.
 */
const MUTATION_REACTIVITY = {
  addAccount: [ACCOUNTS_KEY, CALENDARS_KEY, EVENTS_KEY, TASKS_KEY, TASKLISTS_KEY],
  clearLocationCache: [LOCATION_GEO_KEY],
  completeTask: [TASKS_KEY],
  // The new calendar arrives with the sync pass the handler runs.
  connectAppleCalendar: [ACCOUNTS_KEY, CALENDARS_KEY, EVENTS_KEY],
  connectContacts: [BIRTHDAYS_KEY, CONTACTS_KEY],
  connectReminders: [ACCOUNTS_KEY, TASKLISTS_KEY, TASKS_KEY],
  convertEventToTask: [EVENTS_KEY, OPS_KEY, TASKS_KEY],
  convertTaskToEvent: [EVENTS_KEY, OPS_KEY, TASKS_KEY],
  createEvent: [EVENTS_KEY],
  createMirrorCalendar: [CALENDARS_KEY],
  createTask: [TASKS_KEY],
  deleteEvent: [EVENTS_KEY],
  deleteMirror: [MIRRORS_KEYS, MIRRORS_LOCAL_KEY],
  deleteRecurring: [EVENTS_KEY],
  deleteTask: [TASKS_KEY],
  discardPendingOp: [OPS_KEY],
  // Reads the document; changes nothing.
  exportSettings: [],
  importSettings: [
    ACCOUNTS_KEY,
    CALENDARS_KEY,
    EVENTS_KEY,
    TASKLISTS_KEY,
    TASKS_KEY,
    BIRTHDAY_OVERRIDES_KEY,
    deviceSettingsKey('birthdayReminders'),
    deviceSettingsKey('eventNotifications'),
    deviceSettingsKey('timeZones'),
    deviceSettingsKey('viewPreferences'),
    MIRRORS_KEYS,
  ],
  moveEvent: [EVENTS_KEY, OPS_KEY],
  moveTask: [TASKS_KEY, OPS_KEY],
  // Read what a conversion or a move would drop; change nothing.
  previewEventToTask: [],
  previewMirror: [],
  previewMove: [],
  previewSettingsImport: [],
  removeAccount: [ACCOUNTS_KEY, BIRTHDAYS_KEY, CALENDARS_KEY, EVENTS_KEY, TASKS_KEY, TASKLISTS_KEY],
  resolveConflict: [EVENTS_KEY, OPS_KEY],
  // Geocodes a picked place suggestion; writes only the device-local cache.
  resolveLocation: [],
  respondToEvent: [EVENTS_KEY],
  // The pass writes its status rows itself; the backend invalidates them.
  runMirrorsNow: [],
  saveMirror: [MIRRORS_KEYS, MIRRORS_LOCAL_KEY],
  setBirthdayReminderOverride: [BIRTHDAY_OVERRIDES_KEY],
  setBirthdayReminderSettings: [deviceSettingsKey('birthdayReminders')],
  setCalendarColor: [CALENDARS_KEY],
  setCalendarVisible: [CALENDARS_KEY, EVENTS_KEY],
  setEventNotificationSettings: [deviceSettingsKey('eventNotifications')],
  setMirrorEnabled: [MIRRORS_LOCAL_KEY],
  setTaskListVisible: [TASKLISTS_KEY, TASKS_KEY],
  setTimeZoneSettings: [deviceSettingsKey('timeZones')],
  setViewPreferences: [deviceSettingsKey('viewPreferences')],
  syncNow: [],
  updateEvent: [EVENTS_KEY],
  updateRecurring: [EVENTS_KEY],
  updateTask: [TASKS_KEY],
} satisfies Partial<Record<keyof BackendClient, ReadonlyArray<string>>>;

export type MutationName = keyof typeof MUTATION_REACTIVITY;

/**
 * The engine's time zone, read again once a minute and set only when it
 * changed, so nothing downstream refetches on a tick. The stored time
 * zones default to it: after a flight (or a zone picked in the OS
 * settings) the grid and "today" must follow without a relaunch. A
 * suspended app's timer fires on resume, so a foreground is covered too.
 */
export const deviceZoneAtom = (
  read: () => string = () => Temporal.Now.timeZoneId(),
  intervalMs = 60_000,
): Atom.Atom<string> =>
  Atom.readable((get) => {
    let current = read();
    const timer = setInterval(() => {
      const zone = read();
      if (zone !== current) {
        current = zone;
        get.setSelf(zone);
      }
    }, intervalMs);
    get.addFinalizer(() => clearInterval(timer));
    return current;
  });

const buildAtoms = (client: BackendClient, deviceZone: Atom.Atom<string>) => {
  const runtime = Atom.runtime(Layer.succeed(AppBackend, client));

  const accounts = runtime
    .atom(
      Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.listAccounts(undefined);
      }),
    )
    .pipe(Atom.withReactivity([ACCOUNTS_KEY]));

  const calendars = runtime
    .atom(
      Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.listCalendars({});
      }),
    )
    .pipe(Atom.withReactivity([CALENDARS_KEY]));

  // Refetched per imported page (EVENTS_KEY) while Settings is mounted —
  // one COUNT per page is nothing next to the page itself — and the moment
  // a pass finishes (SYNC_STATE_KEY).
  // Definitions and this device's status rows: both change what the row shows.
  const mirrors = runtime
    .atom(
      Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.listMirrors(undefined);
      }),
    )
    .pipe(Atom.withReactivity([MIRRORS_KEYS, MIRRORS_LOCAL_KEY]));

  const syncStatus = runtime
    .atom(
      Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.listSyncStatus(undefined);
      }),
    )
    .pipe(Atom.withReactivity([ACCOUNTS_KEY, EVENTS_KEY, SYNC_STATE_KEY]));

  const pendingOps = runtime
    .atom(
      Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.listPendingOps(undefined);
      }),
    )
    .pipe(Atom.withReactivity([OPS_KEY]));

  // Bounded LRU instead of Atom.family: the family memoizes per key
  // forever, so months of navigation would accumulate range atoms. The cap
  // comfortably exceeds what is ever mounted at once; an evicted range that
  // is revisited simply refetches.
  //
  // EVENTS_KEY only: anything that changes which events a window returns
  // (visibility toggles, calendar removal) invalidates EVENTS_KEY on the
  // repo side. Subscribing to CALENDARS_KEY too made every color change
  // and every calendar-list sync pass refetch and re-expand every mounted
  // range.
  const eventsInRange = boundedAtomCache((key) => {
    const [start, end] = key.split(':', 2);
    const rangeStartUtc = Number(start);
    const rangeEndUtc = Number(end);
    return runtime
      .atom(
        Effect.gen(function* () {
          const backend = yield* AppBackend;
          return yield* backend.getEventsInRange({ rangeEndUtc, rangeStartUtc });
        }),
      )
      .pipe(Atom.withReactivity([EVENTS_KEY]));
  });

  const taskLists = runtime
    .atom(
      Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.listTaskLists(undefined);
      }),
    )
    .pipe(Atom.withReactivity([TASKLISTS_KEY]));

  // Keys are date strings because task due days are date-only. TASKS_KEY
  // only, for the same reason as eventsInRange: list visibility and list
  // removal invalidate TASKS_KEY on the repo side.
  const tasksInRange = boundedAtomCache((key) => {
    const [start, end] = key.split(':', 2);
    const startDate = start ?? '';
    const endDate = end ?? '';
    return runtime
      .atom(
        Effect.gen(function* () {
          const backend = yield* AppBackend;
          return yield* backend.getTasksInRange({ endDate, startDate });
        }),
      )
      .pipe(Atom.withReactivity([TASKS_KEY]));
  });

  // Keyed by today's date: open tasks due before it, drawn on today. Rolls
  // to a new key at local midnight (useToday) and refetches on TASKS_KEY.
  const overdueTasks = boundedAtomCache((before) =>
    runtime
      .atom(
        Effect.gen(function* () {
          const backend = yield* AppBackend;
          return yield* backend.getOverdueTasks({ before });
        }),
      )
      .pipe(Atom.withReactivity([TASKS_KEY])),
  );

  const birthdayReminderOverrides = runtime
    .atom(
      Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.getBirthdayReminderOverrides(undefined);
      }),
    )
    .pipe(Atom.withReactivity([BIRTHDAY_OVERRIDES_KEY]));

  // Keyed per setting: the reminder scheduler's own bookkeeping rows never
  // refetch this.
  const birthdayReminderSettings = runtime
    .atom(
      Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.getBirthdayReminderSettings(undefined);
      }),
    )
    .pipe(Atom.withReactivity([deviceSettingsKey('birthdayReminders')]));

  const eventNotificationSettings = runtime
    .atom(
      Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.getEventNotificationSettings(undefined);
      }),
    )
    .pipe(Atom.withReactivity([deviceSettingsKey('eventNotifications')]));

  // Device-local time zones; refetched when they are written and when the
  // device's zone changes (nothing stored reads as the device zone).
  const timeZoneSettings = runtime
    .atom((get) => {
      get(deviceZone);
      return Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.getTimeZoneSettings(undefined);
      });
    })
    .pipe(Atom.withReactivity([deviceSettingsKey('timeZones')]));

  // Device-local view preferences; refetched only when they are written.
  const viewPreferences = runtime
    .atom(
      Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.getViewPreferences(undefined);
      }),
    )
    .pipe(Atom.withReactivity([deviceSettingsKey('viewPreferences')]));

  // Keys are date strings, like tasksInRange. BIRTHDAYS_KEY fires from the
  // Google cache writes and from a device snapshot that changed the list.
  const birthdaysInRange = boundedAtomCache((key) => {
    const [start, end] = key.split(':', 2);
    const startDate = start ?? '';
    const endDate = end ?? '';
    return runtime
      .atom(
        Effect.gen(function* () {
          const backend = yield* AppBackend;
          return yield* backend.getBirthdaysInRange({ endDate, startDate });
        }),
      )
      .pipe(Atom.withReactivity([BIRTHDAYS_KEY]));
  });

  // Typeahead queries, keyed `${limit}:${query}`. CONTACTS_KEY re-runs an
  // open query when a sync pass or a grant lands.
  const contactsSearch = boundedAtomCache((key) => {
    const separator = key.indexOf(':');
    const query = key.slice(separator + 1);
    const limit = Number(key.slice(0, separator));
    return runtime
      .atom(
        Effect.gen(function* () {
          const backend = yield* AppBackend;
          return yield* backend.searchContacts({ limit, query });
        }),
      )
      .pipe(Atom.withReactivity([CONTACTS_KEY]));
  });

  // Location typeahead, keyed `${limit}:${query}`. No reactivity: MapKit
  // results do not change with anything the backend stores. An empty
  // query never reaches the backend.
  const placesSearch = boundedAtomCache((key) => {
    const separator = key.indexOf(':');
    const query = key.slice(separator + 1);
    const limit = Number(key.slice(0, separator));
    return runtime.atom(
      query === ''
        ? Effect.succeed([])
        : Effect.gen(function* () {
            const backend = yield* AppBackend;
            return yield* backend.searchPlaces({ limit, query });
          }),
    );
  });

  // Coordinates for an event's location text (cached per string on the
  // backend). Keyed by the exact text; '' resolves to null locally.
  // LOCATION_GEO_KEY re-reads when a background refresh lands or the
  // cache is wiped, so an open editor's map follows.
  const locationGeo = boundedAtomCache((location) =>
    runtime
      .atom(
        location === ''
          ? Effect.succeed(null)
          : Effect.gen(function* () {
              const backend = yield* AppBackend;
              return yield* backend.resolveLocation({ location });
            }),
      )
      .pipe(Atom.withReactivity([LOCATION_GEO_KEY])),
  );

  // One stored event by `accountId|calendarId|eventId`: the editor reads
  // a series' master for its rule. '' resolves to null.
  const eventById = boundedAtomCache((key) =>
    runtime
      .atom(
        key === ''
          ? Effect.succeed(null)
          : Effect.gen(function* () {
              const backend = yield* AppBackend;
              const [accountId = '', calendarId = '', eventId = ''] = key.split('|', 3);
              return yield* backend.getEvent({ accountId, calendarId, eventId });
            }),
      )
      .pipe(Atom.withReactivity([EVENTS_KEY])),
  );

  // Desktop map images, keyed by mapSnapshotKey; '' resolves to null.
  const mapSnapshot = boundedAtomCache((key) =>
    runtime.atom(
      key === ''
        ? Effect.succeed(null)
        : Effect.gen(function* () {
            const backend = yield* AppBackend;
            const result = yield* backend.mapSnapshot(parseMapSnapshotKey(key));
            return result.pngBase64;
          }),
    ),
  );

  const mutation = <M extends keyof BackendClient>(
    method: M,
    reactivityKeys: ReadonlyArray<string>,
  ) =>
    runtime.fn(
      (payload: BackendPayload<M>) =>
        Effect.gen(function* () {
          const backend = yield* AppBackend;
          return (yield* backend[method](payload as never)) as BackendSuccess<M>;
        }),
      { reactivityKeys },
    );

  /**
   * A fresh fn atom for one call of a mutation (`runMutation`). One shared
   * atom per mutation ran its calls "latest wins": a second call while the
   * first was still running interrupted it — a quick second drag could drop
   * the first write — and both callers read the second one's result.
   */
  const mutationCall = <M extends MutationName>(name: M) =>
    mutation(name, MUTATION_REACTIVITY[name]);

  /** The runtime's own Reactivity — the bridge target for backend keys. */
  const reactivityAccessor = runtime.atom(
    Effect.gen(function* () {
      return yield* Reactivity.Reactivity;
    }),
  );

  const bindInvalidations = (
    registry: AtomRegistry.AtomRegistry,
    subscribe: (listener: (keys: ReadonlyArray<unknown>) => void) => () => void,
  ): (() => void) => {
    const unmount = registry.mount(reactivityAccessor);
    const unsubscribe = subscribe((keys) => {
      const result = registry.get(reactivityAccessor);
      if (AsyncResult.isSuccess(result)) {
        result.value.invalidateUnsafe(keys);
      }
    });
    return () => {
      unsubscribe();
      unmount();
    };
  };

  return {
    accounts,
    bindInvalidations,
    birthdayReminderOverrides,
    birthdayReminderSettings,
    birthdaysInRange,
    calendars,
    contactsSearch,
    eventById,
    eventNotificationSettings,
    eventsInRange,
    locationGeo,
    mapSnapshot,
    mirrors,
    mutationCall,
    overdueTasks,
    pendingOps,
    placesSearch,
    syncStatus,
    taskLists,
    tasksInRange,
    timeZoneSettings,
    viewPreferences,
  };
};

/** Builds the app's atom bundle around a platform BackendClient. Call once. */
/** How many keyed atoms each bounded cache keeps before evicting the least recently used. */
const ATOM_CACHE_LIMIT = 32;

/**
 * A keyed atom cache with LRU eviction, written once instead of three
 * times: a hit is re-inserted to refresh its recency; a miss builds the
 * atom and drops the oldest entry past the cap (an evicted key that is
 * revisited simply refetches).
 */
const boundedAtomCache = <A>(make: (key: string) => A, limit = ATOM_CACHE_LIMIT) => {
  const cache = new Map<string, A>();
  return (key: string): A => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const atom = make(key);
    cache.set(key, atom);
    if (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    return atom;
  };
};

export const makeBackendAtoms = (
  client: BackendClient,
  deviceZone: Atom.Atom<string> = deviceZoneAtom(),
): BackendAtoms => buildAtoms(client, deviceZone);

/**
 * Runs one call of a backend mutation on an atom of its own and resolves
 * with that call's result (or throws its failure). Concurrent calls of the
 * same mutation run side by side, each to its own end.
 */
export const runMutation = async <M extends MutationName>(
  registry: AtomRegistry.AtomRegistry,
  atoms: Pick<BackendAtoms, 'mutationCall'>,
  name: M,
  payload: BackendPayload<M>,
): Promise<BackendSuccess<M>> => {
  const atom = atoms.mutationCall(name);
  registry.set(atom, payload as never);
  const result: Effect.Effect<BackendSuccess<M>, unknown> = AtomRegistry.getResult(registry, atom, {
    suspendOnWaiting: true,
  });
  const exit = await Effect.runPromiseExit(result);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};
