import {
  Account,
  AccountSyncStatus,
  APPLE_CALENDAR_ACCOUNT_ID,
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
  birthdaysInRange,
  rankContacts,
} from '@calendar/core';
import { AppleCalendarClient } from '@calendar/apple-calendar';
import { ContactsClient, contactsReadable } from '@calendar/contacts';
import {
  AccountRepo,
  BirthdayRepo,
  CalendarRepo,
  ContactRepo,
  DeviceSettingsRepo,
  EventRepo,
  LocationGeoRepo,
  PendingOpRepo,
  SyncStateRepo,
  TaskRepo,
} from '@calendar/db';
import { GeoClient } from '@calendar/geo';
import { TokenStore } from '@calendar/google';
import { RemindersClient } from '@calendar/reminders';
import { Clock, Effect, Queue, Stream } from 'effect';
import { AppleCalendarEvents } from './appleCalendarEvents.ts';
import { BirthdayReminders } from './birthdayReminders.ts';
import { loadMergedBirthdays } from './birthdays.ts';
import { DeviceContacts } from './deviceContacts.ts';
import { readBirthdayReminderSettings, writeBirthdayReminderSettings } from './deviceSettings.ts';
import { NotificationSink } from './notificationSink.ts';
import { SyncEngine } from './engine.ts';
import { locationHandlers } from './locationHandlers.ts';
import { EventMutations } from './mutations.ts';

/** Suggestions shown at once; the repo is asked for a few times that before ranking. */
const DEFAULT_SEARCH_LIMIT = 8;

export type CommonBackendServices =
  | AccountRepo
  | AppleCalendarClient
  | AppleCalendarEvents
  | BirthdayReminders
  | BirthdayRepo
  | CalendarRepo
  | ContactRepo
  | ContactsClient
  | DeviceContacts
  | DeviceSettingsRepo
  | EventMutations
  | EventRepo
  | GeoClient
  | LocationGeoRepo
  | NotificationSink
  | PendingOpRepo
  | RemindersClient
  | SyncEngine
  | SyncStateRepo
  | TaskRepo
  | TokenStore;

/**
 * The platform-independent AppBackend handlers. Platforms add `addAccount`
 * (the OAuth code-acquisition step differs) on top of these.
 */
export const commonBackendHandlers: Omit<BackendHandlers<CommonBackendServices>, 'addAccount'> = {
  ...locationHandlers,

  completeTask: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.completeTask(params);
    }),

  // Asks for Contacts access (the OS prompt when undetermined) and loads
  // the address book into the typeahead cache on grant. A refusal resolves
  // to false; a failed request remains an error. iOS may already have asked
  // before initializing the backend, so reuse an existing grant.
  connectContacts: () =>
    Effect.gen(function* () {
      const contactsClient = yield* ContactsClient;
      const granted =
        contactsReadable(yield* contactsClient.status()) || (yield* contactsClient.requestAccess());
      if (granted) {
        yield* (yield* DeviceContacts).refresh();
      }
      return { granted };
    }),

  // Asks EventKit for events access (the OS prompt when undetermined; a
  // separate grant from Reminders). On grant the synthetic Apple Calendar
  // account appears and a sync mirrors its calendars; events are read live.
  connectAppleCalendar: () =>
    Effect.gen(function* () {
      const client = yield* AppleCalendarClient;
      // An existing grant does not prompt again; the bridge resets its
      // store after a grant made in Settings.
      const granted = yield* client.requestAccess();
      if (!granted) {
        return { granted: false };
      }
      const accountRepo = yield* AccountRepo;
      const existing = yield* accountRepo.get(APPLE_CALENDAR_ACCOUNT_ID);
      yield* accountRepo.upsert(
        new Account({
          contactsEnabled: false,
          createdAt: existing?.createdAt ?? (yield* Clock.currentTimeMillis),
          displayName: 'Apple Calendar',
          email: '',
          id: APPLE_CALENDAR_ACCOUNT_ID,
          provider: 'apple',
          status: 'ok',
          tasksEnabled: false,
        }),
      );
      const engine = yield* SyncEngine;
      yield* Effect.forkDetach(engine.syncAll());
      return { granted: true };
    }),

  // Asks EventKit (the OS prompt when undetermined); on grant the synthetic
  // Apple account appears and a sync fills its lists. Denied leaves no trace
  // — the Settings row keeps offering the ask.
  connectReminders: () =>
    Effect.gen(function* () {
      const remindersClient = yield* RemindersClient;
      // An existing grant does not prompt again. Keep this call: the native
      // bridge resets EventKit's store after a grant made in Settings.
      const granted = yield* remindersClient.requestAccess();
      if (!granted) {
        return { granted: false };
      }
      const accountRepo = yield* AccountRepo;
      const existing = (yield* accountRepo.list()).find(
        (account) => account.id === APPLE_REMINDERS_ACCOUNT_ID,
      );
      yield* accountRepo.upsert(
        new Account({
          contactsEnabled: false,
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

  getBirthdayReminderSettings: () => readBirthdayReminderSettings,

  getBirthdaysInRange: ({ endDate, startDate }) =>
    Effect.map(loadMergedBirthdays, (records) => birthdaysInRange(records, startDate, endDate)),

  getEventsInRange: ({ rangeEndUtc, rangeStartUtc }) =>
    Effect.gen(function* () {
      const events = yield* EventRepo;
      const window = yield* events.getWindow(rangeStartUtc, rangeEndUtc);
      const skipped: Array<string> = [];
      const result = assembleWindow(window, rangeStartUtc, rangeEndUtc, (master, error) =>
        skipped.push(`${master.calendarId}/${master.id}: ${String(error)}`),
      );
      if (skipped.length > 0) {
        yield* Effect.logWarning('recurring masters skipped in window', { skipped });
      }
      // Apple Calendar events are never stored: EventKit answers the range live.
      const apple = yield* (yield* AppleCalendarEvents).eventsInRange(rangeStartUtc, rangeEndUtc);
      return apple.length === 0
        ? result
        : [...result, ...apple].sort((a, b) => a.startUtc - b.startUtc);
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

  listSyncStatus: () =>
    Effect.gen(function* () {
      const accounts = yield* (yield* AccountRepo).list();
      const summaries = yield* (yield* SyncStateRepo).summarizeEvents();
      const counts = yield* (yield* EventRepo).countByAccount();
      const importing = new Map(summaries.map((row) => [row.accountId, row.importing]));
      const eventCount = new Map(counts.map((row) => [row.accountId, row.eventCount]));
      return accounts.map(
        (account) =>
          new AccountSyncStatus({
            accountId: account.id,
            eventCount: eventCount.get(account.id) ?? 0,
            importing: (importing.get(account.id) ?? 0) > 0,
          }),
      );
    }),

  listTaskLists: () =>
    Effect.gen(function* () {
      const taskRepo = yield* TaskRepo;
      return yield* taskRepo.listLists();
    }),

  moveEvent: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.moveEvent(params);
    }),

  previewMove: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      return yield* mutations.previewMove(params);
    }),

  removeAccount: ({ accountId }) =>
    Effect.gen(function* () {
      const accountRepo = yield* AccountRepo;
      const account = (yield* accountRepo.list()).find((candidate) => candidate.id === accountId);
      if (account?.provider !== 'apple') {
        // The Apple accounts hold no tokens; their data is the cascade below.
        const tokenStore = yield* TokenStore;
        yield* tokenStore.remove(accountId);
      }
      yield* accountRepo.remove(accountId);
      if (accountId === APPLE_CALENDAR_ACCOUNT_ID) {
        // Its events are not in the cascade (never stored): repaint the views.
        yield* (yield* AppleCalendarEvents).invalidate;
      }
    }),

  respondToEvent: (params) =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent(params);
    }),

  searchContacts: ({ limit, query }) =>
    Effect.gen(function* () {
      const take = limit ?? DEFAULT_SEARCH_LIMIT;
      const google = yield* (yield* ContactRepo).search(query, take * 4);
      const device = yield* (yield* DeviceContacts).list();
      return rankContacts(query, [...google, ...device], take);
    }),

  // Saves, asks the OS for notification permission when enabling on a
  // platform that pre-schedules (iOS), and runs a reminder pass right
  // away so the schedule reflects the new choice.
  setBirthdayReminderSettings: (settings) =>
    Effect.gen(function* () {
      yield* writeBirthdayReminderSettings(settings);
      const sink = yield* NotificationSink;
      const notificationsGranted =
        settings.enabled && sink.kind === 'scheduled' ? yield* sink.ensurePermission() : true;
      yield* Effect.forkDetach((yield* BirthdayReminders).run());
      return { notificationsGranted };
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
      if (accountId === APPLE_CALENDAR_ACCOUNT_ID) {
        // Its events are read from EventKit, not joined from SQLite: repaint.
        yield* (yield* AppleCalendarEvents).invalidate;
      }
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
