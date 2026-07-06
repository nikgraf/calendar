import {
  AppBackendRpcs,
  assembleWindow,
  mapToBackendError,
  type BackendHandlers,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo, PendingOpRepo } from '@calendar/db';
import { TokenStore } from '@calendar/google';
import { Effect, Queue, Stream } from 'effect';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';

export type CommonBackendServices =
  | AccountRepo
  | CalendarRepo
  | EventMutations
  | EventRepo
  | PendingOpRepo
  | SyncEngine
  | TokenStore;

/**
 * The platform-independent AppBackend handlers. Platforms add `addAccount`
 * (the OAuth code-acquisition step differs) on top of these.
 */
export const commonBackendHandlers: Omit<BackendHandlers<CommonBackendServices>, 'addAccount'> = {
  createEvent: (draft) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      return yield* mutations.createEvent(draft);
    }),

  deleteEvent: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.deleteEvent(params);
    }),

  deleteRecurring: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.deleteRecurring(params);
    }),

  discardPendingOp: ({ opId }) =>
    Effect.gen(function* () {
      const pendingOps = yield* PendingOpRepo;
      yield* pendingOps.remove(opId);
    }),

  getEventsInRange: ({ rangeEndUtc, rangeStartUtc }) =>
    Effect.gen(function* () {
      const events = yield* EventRepo;
      const window = yield* events.getWindow(rangeStartUtc, rangeEndUtc);
      return assembleWindow(window, rangeStartUtc, rangeEndUtc);
    }),

  listAccounts: () =>
    Effect.gen(function* () {
      const accountRepo = yield* AccountRepo;
      return yield* accountRepo.list();
    }),

  listCalendars: ({ accountId }) =>
    Effect.gen(function* () {
      const calendarRepo = yield* CalendarRepo;
      return yield* calendarRepo.list(accountId);
    }),

  listPendingOps: () =>
    Effect.gen(function* () {
      const pendingOps = yield* PendingOpRepo;
      const ops = yield* pendingOps.listAll();
      return ops.map((op) => ({
        attempts: op.attempts,
        calendarId: op.calendarId,
        createdAt: op.createdAt,
        eventId: op.eventId,
        id: op.id,
        kind: op.kind,
        nextAttemptAt: op.nextAttemptAt,
        ...(op.lastError === undefined ? {} : { lastError: op.lastError }),
        ...(op.payload?.title === undefined ? {} : { title: op.payload.title }),
      }));
    }),

  removeAccount: ({ accountId }) =>
    Effect.gen(function* () {
      const accountRepo = yield* AccountRepo;
      const tokenStore = yield* TokenStore;
      yield* tokenStore.remove(accountId);
      yield* accountRepo.remove(accountId);
    }),

  respondToEvent: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent(params);
    }),

  setCalendarColor: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.setCalendarColor(params);
    }),

  setCalendarVisible: ({ accountId, calendarId, isVisible }) =>
    Effect.gen(function* () {
      const calendarRepo = yield* CalendarRepo;
      yield* calendarRepo.setVisible(accountId, calendarId, isVisible);
    }),

  syncNow: () =>
    Effect.gen(function* () {
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
    }),

  updateEvent: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.updateEvent(params);
    }),

  updateRecurring: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring(params);
    }),
};

/**
 * Builds the AppBackend rpc handlers layer from platform pieces: the full
 * handler record (common + platform addAccount) and the invalidation feed.
 * Handler errors are normalized to the declared BackendError schema so they
 * cross the rpc boundary as typed failures instead of defects.
 */
export const makeAppBackendLayer = <R>(options: {
  readonly handlers: BackendHandlers<R>;
  readonly subscribeInvalidations: (listener: (keys: ReadonlyArray<string>) => void) => () => void;
}) =>
  AppBackendRpcs.toLayer({
    addAccount: () => mapToBackendError(options.handlers.addAccount(undefined)),
    createEvent: (payload) => mapToBackendError(options.handlers.createEvent(payload)),
    deleteEvent: (payload) => mapToBackendError(options.handlers.deleteEvent(payload)),
    deleteRecurring: (payload) => mapToBackendError(options.handlers.deleteRecurring(payload)),
    discardPendingOp: (payload) => mapToBackendError(options.handlers.discardPendingOp(payload)),
    getEventsInRange: (payload) => mapToBackendError(options.handlers.getEventsInRange(payload)),
    invalidations: () =>
      Stream.callback<ReadonlyArray<string>>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            options.subscribeInvalidations((keys) => {
              Queue.offerUnsafe(queue, keys);
            }),
          ),
          (unsubscribe) => Effect.sync(() => unsubscribe()),
        ),
      ),
    listAccounts: () => mapToBackendError(options.handlers.listAccounts(undefined)),
    listCalendars: (payload) => mapToBackendError(options.handlers.listCalendars(payload)),
    listPendingOps: () => mapToBackendError(options.handlers.listPendingOps(undefined)),
    removeAccount: (payload) => mapToBackendError(options.handlers.removeAccount(payload)),
    respondToEvent: (payload) => mapToBackendError(options.handlers.respondToEvent(payload)),
    setCalendarColor: (payload) => mapToBackendError(options.handlers.setCalendarColor(payload)),
    setCalendarVisible: (payload) =>
      mapToBackendError(options.handlers.setCalendarVisible(payload)),
    syncNow: () => mapToBackendError(options.handlers.syncNow(undefined)),
    updateEvent: (payload) => mapToBackendError(options.handlers.updateEvent(payload)),
    updateRecurring: (payload) => mapToBackendError(options.handlers.updateRecurring(payload)),
  });
