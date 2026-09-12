import {
  ACCOUNTS_KEY,
  CALENDARS_KEY,
  CONTACTS_KEY,
  EVENTS_KEY,
  OPS_KEY,
  TASKLISTS_KEY,
  TASKS_KEY,
} from '@calendar/db/keys';
import type { BackendClient, BackendPayload, BackendSuccess } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Atom, AsyncResult, Reactivity, type AtomRegistry } from 'effect/unstable/reactivity';

/** The BackendClient as a service, so atom effects can yield it. */
export class AppBackend extends Context.Service<AppBackend, BackendClient>()(
  'app-state/AppBackend',
) {}

export const rangeKey = (rangeStartUtc: number, rangeEndUtc: number): string =>
  `${rangeStartUtc}:${rangeEndUtc}`;

export interface BackendAtoms {
  readonly accounts: ReturnType<typeof buildAtoms>['accounts'];
  readonly bindInvalidations: (
    registry: AtomRegistry.AtomRegistry,
    subscribe: (listener: (keys: ReadonlyArray<unknown>) => void) => () => void,
  ) => () => void;
  readonly calendars: ReturnType<typeof buildAtoms>['calendars'];
  readonly contactsSearch: ReturnType<typeof buildAtoms>['contactsSearch'];
  readonly eventsInRange: ReturnType<typeof buildAtoms>['eventsInRange'];
  readonly mutations: ReturnType<typeof buildAtoms>['mutations'];
  readonly pendingOps: ReturnType<typeof buildAtoms>['pendingOps'];
  readonly taskLists: ReturnType<typeof buildAtoms>['taskLists'];
  readonly tasksInRange: ReturnType<typeof buildAtoms>['tasksInRange'];
}

/**
 * The UI-runtime Reactivity keys each mutation invalidates — the single
 * source for which mutation atoms exist (the atoms record is derived from
 * these entries). Keys chosen per method; syncNow is empty because the
 * backend invalidates through the bridge as sync data lands.
 */
const MUTATION_REACTIVITY = {
  addAccount: [ACCOUNTS_KEY, CALENDARS_KEY, EVENTS_KEY, TASKS_KEY, TASKLISTS_KEY],
  completeTask: [TASKS_KEY],
  connectContacts: [CONTACTS_KEY],
  connectReminders: [ACCOUNTS_KEY, TASKLISTS_KEY, TASKS_KEY],
  createEvent: [EVENTS_KEY],
  createTask: [TASKS_KEY],
  deleteEvent: [EVENTS_KEY],
  deleteRecurring: [EVENTS_KEY],
  deleteTask: [TASKS_KEY],
  discardPendingOp: [OPS_KEY],
  removeAccount: [ACCOUNTS_KEY, CALENDARS_KEY, EVENTS_KEY, TASKS_KEY, TASKLISTS_KEY],
  respondToEvent: [EVENTS_KEY],
  setCalendarColor: [CALENDARS_KEY],
  setCalendarVisible: [CALENDARS_KEY, EVENTS_KEY],
  setTaskListVisible: [TASKLISTS_KEY, TASKS_KEY],
  syncNow: [],
  updateEvent: [EVENTS_KEY],
  updateRecurring: [EVENTS_KEY],
  updateTask: [TASKS_KEY],
} satisfies Partial<Record<keyof BackendClient, ReadonlyArray<string>>>;

export type MutationName = keyof typeof MUTATION_REACTIVITY;
const mutationNames = Object.keys(MUTATION_REACTIVITY) as ReadonlyArray<MutationName>;

const buildAtoms = (client: BackendClient) => {
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

  const mutations = Object.fromEntries(
    mutationNames.map((name) => [name, mutation(name, MUTATION_REACTIVITY[name])]),
  ) as { [M in MutationName]: ReturnType<typeof mutation<M>> };

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
    calendars,
    contactsSearch,
    eventsInRange,
    mutations,
    pendingOps,
    taskLists,
    tasksInRange,
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

export const makeBackendAtoms = (client: BackendClient): BackendAtoms => buildAtoms(client);
