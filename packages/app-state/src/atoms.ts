import {
  ACCOUNTS_KEY,
  CALENDARS_KEY,
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
  readonly eventsInRange: ReturnType<typeof buildAtoms>['eventsInRange'];
  readonly mutations: ReturnType<typeof buildAtoms>['mutations'];
  readonly pendingOps: ReturnType<typeof buildAtoms>['pendingOps'];
  readonly taskLists: ReturnType<typeof buildAtoms>['taskLists'];
  readonly tasksInRange: ReturnType<typeof buildAtoms>['tasksInRange'];
}

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
  const RANGE_CACHE_LIMIT = 32;
  const rangeAtoms = new Map<string, ReturnType<typeof makeRangeAtom>>();
  const makeRangeAtom = (rangeStartUtc: number, rangeEndUtc: number) =>
    runtime
      .atom(
        Effect.gen(function* () {
          const backend = yield* AppBackend;
          return yield* backend.getEventsInRange({ rangeEndUtc, rangeStartUtc });
        }),
      )
      .pipe(Atom.withReactivity([EVENTS_KEY, CALENDARS_KEY]));
  const eventsInRange = (key: string) => {
    const cached = rangeAtoms.get(key);
    if (cached) {
      // Re-insert to refresh recency.
      rangeAtoms.delete(key);
      rangeAtoms.set(key, cached);
      return cached;
    }
    const [start, end] = key.split(':', 2);
    const atom = makeRangeAtom(Number(start), Number(end));
    rangeAtoms.set(key, atom);
    if (rangeAtoms.size > RANGE_CACHE_LIMIT) {
      const oldest = rangeAtoms.keys().next().value;
      if (oldest !== undefined) {
        rangeAtoms.delete(oldest);
      }
    }
    return atom;
  };

  const taskLists = runtime
    .atom(
      Effect.gen(function* () {
        const backend = yield* AppBackend;
        return yield* backend.listTaskLists(undefined);
      }),
    )
    .pipe(Atom.withReactivity([TASKLISTS_KEY]));

  // Same bounded-LRU shape as eventsInRange; keys are date strings because
  // task due days are date-only.
  const taskRangeAtoms = new Map<string, ReturnType<typeof makeTaskRangeAtom>>();
  const makeTaskRangeAtom = (startDate: string, endDate: string) =>
    runtime
      .atom(
        Effect.gen(function* () {
          const backend = yield* AppBackend;
          return yield* backend.getTasksInRange({ endDate, startDate });
        }),
      )
      .pipe(Atom.withReactivity([TASKS_KEY, TASKLISTS_KEY]));
  const tasksInRange = (key: string) => {
    const cached = taskRangeAtoms.get(key);
    if (cached) {
      taskRangeAtoms.delete(key);
      taskRangeAtoms.set(key, cached);
      return cached;
    }
    const [start, end] = key.split(':', 2);
    const atom = makeTaskRangeAtom(start ?? '', end ?? '');
    taskRangeAtoms.set(key, atom);
    if (taskRangeAtoms.size > RANGE_CACHE_LIMIT) {
      const oldest = taskRangeAtoms.keys().next().value;
      if (oldest !== undefined) {
        taskRangeAtoms.delete(oldest);
      }
    }
    return atom;
  };

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

  const mutations = {
    addAccount: mutation('addAccount', [
      ACCOUNTS_KEY,
      CALENDARS_KEY,
      EVENTS_KEY,
      TASKS_KEY,
      TASKLISTS_KEY,
    ]),
    completeTask: mutation('completeTask', [TASKS_KEY]),
    createEvent: mutation('createEvent', [EVENTS_KEY]),
    deleteEvent: mutation('deleteEvent', [EVENTS_KEY]),
    deleteRecurring: mutation('deleteRecurring', [EVENTS_KEY]),
    discardPendingOp: mutation('discardPendingOp', [OPS_KEY]),
    removeAccount: mutation('removeAccount', [
      ACCOUNTS_KEY,
      CALENDARS_KEY,
      EVENTS_KEY,
      TASKS_KEY,
      TASKLISTS_KEY,
    ]),
    respondToEvent: mutation('respondToEvent', [EVENTS_KEY]),
    setCalendarColor: mutation('setCalendarColor', [CALENDARS_KEY]),
    setCalendarVisible: mutation('setCalendarVisible', [CALENDARS_KEY, EVENTS_KEY]),
    setTaskListVisible: mutation('setTaskListVisible', [TASKLISTS_KEY, TASKS_KEY]),
    // The backend invalidates through the bridge as sync data lands.
    syncNow: mutation('syncNow', []),
    updateEvent: mutation('updateEvent', [EVENTS_KEY]),
    updateRecurring: mutation('updateRecurring', [EVENTS_KEY]),
  };

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
    eventsInRange,
    mutations,
    pendingOps,
    taskLists,
    tasksInRange,
  };
};

/** Builds the app's atom bundle around a platform BackendClient. Call once. */
export const makeBackendAtoms = (client: BackendClient): BackendAtoms => buildAtoms(client);
