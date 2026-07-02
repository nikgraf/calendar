import { assembleWindow, type BackendHandlers } from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo } from '@calendar/db';
import { TokenStore } from '@calendar/google';
import { Effect } from 'effect';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';

export type CommonBackendServices =
  | AccountRepo
  | CalendarRepo
  | EventMutations
  | EventRepo
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

  removeAccount: ({ accountId }) =>
    Effect.gen(function* () {
      const accountRepo = yield* AccountRepo;
      const tokenStore = yield* TokenStore;
      yield* tokenStore.remove(accountId);
      yield* accountRepo.remove(accountId);
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
};
