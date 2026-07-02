import { assembleWindow, type BackendHandlers } from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo } from '@calendar/db';
import { TokenStore } from '@calendar/google';
import { Effect } from 'effect';
import { SyncEngine } from './engine.ts';

export type CommonBackendServices =
  | AccountRepo
  | CalendarRepo
  | EventRepo
  | SyncEngine
  | TokenStore;

/**
 * The platform-independent AppBackend handlers. Platforms add `addAccount`
 * (the OAuth code-acquisition step differs) on top of these.
 */
export const commonBackendHandlers: Omit<BackendHandlers<CommonBackendServices>, 'addAccount'> = {
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
};
