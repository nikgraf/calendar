import {
  Account,
  APPLE_REMINDERS_ACCOUNT_ID,
  AppBackendRpcs,
  assembleWindow,
  backendMethodNames,
  mapToBackendError,
  type BackendError,
  type BackendHandlers,
  type BackendMethodName,
  type BackendPayload,
  type BackendSuccess,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo, PendingOpRepo, TaskRepo } from '@calendar/db';
import { TokenStore } from '@calendar/google';
import { RemindersClient } from '@calendar/reminders';
import { Clock, Effect, Queue, Stream } from 'effect';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';

export type CommonBackendServices =
  | AccountRepo
  | CalendarRepo
  | EventMutations
  | EventRepo
  | PendingOpRepo
  | RemindersClient
  | SyncEngine
  | TaskRepo
  | TokenStore;

/**
 * The platform-independent AppBackend handlers. Platforms add `addAccount`
 * (the OAuth code-acquisition step differs) on top of these.
 */
export const commonBackendHandlers: Omit<BackendHandlers<CommonBackendServices>, 'addAccount'> = {
  completeTask: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.completeTask(params);
    }),

  // Asks EventKit (the OS prompt when undetermined); on grant the synthetic
  // Apple account appears and a sync fills its lists. Denied leaves no trace
  // — the Settings row keeps offering the ask.
  connectReminders: () =>
    Effect.gen(function* () {
      const remindersClient = yield* RemindersClient;
      const granted = yield* remindersClient
        .requestAccess()
        .pipe(Effect.orElseSucceed(() => false));
      if (!granted) {
        return { granted: false };
      }
      const accountRepo = yield* AccountRepo;
      const existing = (yield* accountRepo.list()).find(
        (account) => account.id === APPLE_REMINDERS_ACCOUNT_ID,
      );
      yield* accountRepo.upsert(
        new Account({
          createdAt: existing?.createdAt ?? (yield* Clock.currentTimeMillis),
          displayName: 'Apple Reminders',
          email: '',
          id: APPLE_REMINDERS_ACCOUNT_ID,
          provider: 'apple',
          status: 'ok',
          tasksEnabled: true,
        }),
      );
      const engine = yield* SyncEngine;
      yield* Effect.forkDetach(engine.syncAll());
      return { granted: true };
    }),

  createEvent: (draft) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      return yield* mutations.createEvent(draft);
    }),

  createTask: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      return yield* mutations.createTask(params);
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

  deleteTask: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.deleteTask(params);
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

  getTasksInRange: ({ endDate, startDate }) =>
    Effect.gen(function* () {
      const taskRepo = yield* TaskRepo;
      return yield* taskRepo.getWindow(startDate, endDate);
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

  listTaskLists: () =>
    Effect.gen(function* () {
      const taskRepo = yield* TaskRepo;
      return yield* taskRepo.listLists();
    }),

  removeAccount: ({ accountId }) =>
    Effect.gen(function* () {
      const accountRepo = yield* AccountRepo;
      const account = (yield* accountRepo.list()).find((candidate) => candidate.id === accountId);
      if (account?.provider !== 'apple') {
        // The Apple account holds no tokens; its data is the cascade below.
        const tokenStore = yield* TokenStore;
        yield* tokenStore.remove(accountId);
      }
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

  setTaskListVisible: ({ accountId, isVisible, taskListId }) =>
    Effect.gen(function* () {
      const taskRepo = yield* TaskRepo;
      yield* taskRepo.setListVisible(accountId, taskListId, isVisible);
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

  updateTask: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.updateTask(params);
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
}) => {
  // Request/response methods are all the same shape — normalize errors and
  // delegate. Derived from the group so adding an rpc means adding only its
  // handler (BackendHandlers stays exhaustively typed); the cast reassembles
  // the per-method entries into the mapped record.
  const methods = Object.fromEntries(
    backendMethodNames.map((name) => [
      name,
      (payload: never) => mapToBackendError(options.handlers[name](payload)),
    ]),
  ) as {
    [M in BackendMethodName]: (
      payload: BackendPayload<M>,
    ) => Effect.Effect<BackendSuccess<M>, BackendError, R>;
  };
  return AppBackendRpcs.toLayer({
    ...methods,
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
  });
};
