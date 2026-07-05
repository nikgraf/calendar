import { ACCOUNTS_KEY, CALENDARS_KEY, EVENTS_KEY, OPS_KEY } from '@calendar/db/keys';
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

  const eventsInRange = Atom.family((key: string) => {
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
      .pipe(Atom.withReactivity([EVENTS_KEY, CALENDARS_KEY]));
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

  const mutations = {
    addAccount: mutation('addAccount', [ACCOUNTS_KEY, CALENDARS_KEY, EVENTS_KEY]),
    createEvent: mutation('createEvent', [EVENTS_KEY]),
    deleteEvent: mutation('deleteEvent', [EVENTS_KEY]),
    deleteRecurring: mutation('deleteRecurring', [EVENTS_KEY]),
    discardPendingOp: mutation('discardPendingOp', [OPS_KEY]),
    removeAccount: mutation('removeAccount', [ACCOUNTS_KEY, CALENDARS_KEY, EVENTS_KEY]),
    respondToEvent: mutation('respondToEvent', [EVENTS_KEY]),
    setCalendarVisible: mutation('setCalendarVisible', [CALENDARS_KEY, EVENTS_KEY]),
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

  return { accounts, bindInvalidations, calendars, eventsInRange, mutations, pendingOps };
};

/** Builds the app's atom bundle around a platform BackendClient. Call once. */
export const makeBackendAtoms = (client: BackendClient): BackendAtoms => buildAtoms(client);
