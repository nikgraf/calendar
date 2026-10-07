import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { Account, eventsScope, plainDateToUtcMs } from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  PendingOpRepo,
  reposLayer,
  runMigrations,
  SyncStateRepo,
  TaskRepo,
} from '@calendar/db';
import {
  ApiUnavailableError,
  type GcalCalendarListPage,
  type GcalEventsPage,
  GoogleApiError,
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GooglePeopleClient,
  type GooglePeopleClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
  NotFoundError,
  ReauthRequiredError,
  SyncTokenExpiredError,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vitest';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';

const calendarListPage: GcalCalendarListPage = {
  items: [
    {
      accessRole: 'owner',
      backgroundColor: '#16a765',
      id: 'cal-1',
      primary: true,
      selected: true,
      summary: 'Personal',
      timeZone: 'Europe/Vienna',
    },
  ],
  nextSyncToken: 'cal-sync-1',
};

const timedItem = (id: string, hour: number) => ({
  end: { dateTime: `2026-07-02T${hour + 1}:00:00Z` },
  etag: `"${id}"`,
  id,
  start: { dateTime: `2026-07-02T${hour}:00:00Z` },
  status: 'confirmed',
  summary: `Event ${id}`,
});

/** Scripted client: each listEvents call shifts the next page. */
const stubClient = (
  eventPages: Array<GcalEventsPage | 'not-found' | 'sync-token-expired' | 'reauth'>,
  calls: Array<{ syncToken?: string | undefined; timeMin?: string | undefined }> = [],
): GoogleCalendarClientShape => ({
  deleteEvent: () => Effect.die('not used'),
  getColors: () => Effect.succeed({ calendar: {} }),
  getEvent: () => Effect.die('unexpected get'),
  insertCalendar: () => Effect.die('not used'),
  insertEvent: () => Effect.die('not used'),
  listCalendars: () => Effect.succeed(calendarListPage),
  listEvents: ({ params }) => {
    calls.push({ syncToken: params.syncToken, timeMin: params.timeMin });
    const next = eventPages.shift();
    if (next === undefined) {
      return Effect.succeed({ items: [] });
    }
    if (next === 'sync-token-expired') {
      return Effect.fail(new SyncTokenExpiredError({ calendarId: 'cal-1' }));
    }
    if (next === 'reauth') {
      return Effect.fail(new ReauthRequiredError({ accountId: 'acc-1' }));
    }
    if (next === 'not-found') {
      return Effect.fail(new NotFoundError({ resource: 'cal-1' }));
    }
    return Effect.succeed(next);
  },
  moveEvent: () => Effect.die('unexpected move'),
  patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
  patchEvent: () => Effect.die('not used'),
  replaceEvent: () => Effect.die('not used'),
});

/**
 * calendarList with Google's delta semantics: a token returns only
 * changes (none here), no token the full list. `calls` records which
 * kind each pass asked for.
 */
const calendarList =
  (
    items: () => GcalCalendarListPage['items'],
    calls: Array<string>,
  ): GoogleCalendarClientShape['listCalendars'] =>
  (params) => {
    calls.push(params.syncToken ?? 'full');
    return Effect.succeed(
      params.syncToken
        ? { items: [], nextSyncToken: 'cal-sync-n' }
        : { items: items(), nextSyncToken: 'cal-sync-1' },
    );
  };

/** Accounts here have tasksEnabled=false, so tasks calls must not happen. */
const stubTasksClient: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('tasks not used in this test'),
  insertTask: () => Effect.die('tasks not used in this test'),
  listTaskLists: () => Effect.die('tasks not enabled in this test'),
  listTasks: () => Effect.die('tasks not enabled in this test'),
  patchTask: () => Effect.die('tasks not enabled in this test'),
};

/** Contacts sync is exercised in contacts.test.ts; keep it inert here. */
const inertPeopleClient: GooglePeopleClientShape = {
  listConnections: () => Effect.die('people not used in this test'),
  listOtherContacts: () => Effect.die('people not used in this test'),
};

const engineLayer = (
  client: GoogleCalendarClientShape,
  tasksClient: GoogleTasksClientShape = stubTasksClient,
) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, client)),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, tasksClient)),
    Layer.provideMerge(Layer.succeed(GooglePeopleClient, inertPeopleClient)),
  );

const seedAccount = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  yield* accounts.upsert(
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'nik@example.com',
      id: 'acc-1',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  );
});

describe('SyncEngine', () => {
  it.effect('a pull leaves a queued local edit alone until the op is acked or abandoned', () => {
    let patchOutcome: 'rejected' | 'transient' = 'transient';
    const serverCopy = { ...timedItem('evt-1', 10), summary: 'Server title' };
    const client: GoogleCalendarClientShape = {
      ...stubClient([
        { items: [timedItem('evt-1', 10)], nextSyncToken: 's1' },
        { items: [serverCopy], nextSyncToken: 's2' },
        { items: [serverCopy], nextSyncToken: 's3' },
      ]),
      patchEvent: () =>
        patchOutcome === 'transient'
          ? Effect.fail(new ApiUnavailableError({ cause: 'offline' }))
          : Effect.fail(new GoogleApiError({ message: 'Invalid value', status: 400 })),
    };
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      const mutations = yield* EventMutations;
      const events = yield* EventRepo;
      const title = () =>
        Effect.map(events.getById('acc-1', 'cal-1', 'evt-1'), (event) => event?.title);
      yield* engine.syncAll();

      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Local title' },
        eventId: 'evt-1',
      });
      // The push fails transiently: the op stays queued, the row stays
      // pending, and the next pull — carrying the server's own title —
      // must not clobber the edit that is still on its way out.
      yield* mutations.processPendingOps();
      yield* engine.syncAll();
      expect(yield* title()).toBe('Local title');

      // Google rejects the edit for good: the row is handed back to sync
      // and the following pull restores the server's version.
      patchOutcome = 'rejected';
      const ops = yield* PendingOpRepo;
      for (const op of yield* ops.listAll()) {
        yield* ops.markFailed(op.id, op.attempts, 0, 'test');
      }
      yield* mutations.processPendingOps();
      expect(yield* ops.listAll()).toHaveLength(0);
      yield* engine.syncAll();
      expect(yield* title()).toBe('Server title');
    }).pipe(Effect.provide(engineLayer(client)));
  });

  it.effect('initial sync persists calendars, paged events, and sync tokens', () => {
    const calls: Array<{ syncToken?: string | undefined; timeMin?: string | undefined }> = [];
    const client = stubClient(
      [
        { items: [timedItem('evt-1', 10)], nextPageToken: 'page-2' },
        { items: [timedItem('evt-2', 12)], nextSyncToken: 'evt-sync-1' },
      ],
      calls,
    );
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      yield* engine.syncAll();

      const calendars = yield* (yield* CalendarRepo).list('acc-1');
      expect(calendars).toHaveLength(1);
      expect(calendars[0]!.colorHex).toBe('#16a765');

      const window = yield* (yield* EventRepo).getWindow(0, plainDateToUtcMs('2030-01-01'));
      expect(window.singles.map((event) => event.id).sort()).toEqual(['evt-1', 'evt-2']);

      const state = yield* (yield* SyncStateRepo).get('acc-1', eventsScope('cal-1'));
      expect(state?.syncToken).toBe('evt-sync-1');
      // Initial pass sends no sync token.
      expect(calls[0]!.syncToken).toBeUndefined();
      expect(calls[0]!.timeMin).toBeUndefined();
    }).pipe(Effect.provide(engineLayer(client)));
  });

  it.effect('an event without a zone of its own is stored in its calendar zone', () => {
    // timedItem sends no start.timeZone. The page names the calendar's zone;
    // without one, the stored calendar's (calendarListPage: Europe/Vienna).
    const client = stubClient([
      { items: [timedItem('evt-1', 10)], nextPageToken: 'page-2', timeZone: 'America/New_York' },
      { items: [timedItem('evt-2', 12)], nextSyncToken: 'evt-sync-1' },
    ]);
    return Effect.gen(function* () {
      yield* seedAccount;
      yield* (yield* SyncEngine).syncAll();
      const window = yield* (yield* EventRepo).getWindow(0, plainDateToUtcMs('2030-01-01'));
      const zones = Object.fromEntries(
        window.singles.map((event) => [event.id, event.startTimeZone]),
      );
      expect(zones).toEqual({ 'evt-1': 'America/New_York', 'evt-2': 'Europe/Vienna' });
    }).pipe(Effect.provide(engineLayer(client)));
  });

  it.effect('incremental sync applies updates and cancellation tombstones', () => {
    const calls: Array<{ syncToken?: string | undefined; timeMin?: string | undefined }> = [];
    const client = stubClient(
      [
        // Pass 1: initial.
        {
          items: [timedItem('evt-1', 10), timedItem('evt-2', 12)],
          nextSyncToken: 'sync-1',
        },
        // Pass 2: incremental — evt-2 cancelled (plain event → deletion).
        {
          items: [
            { ...timedItem('evt-1', 11), summary: 'Moved' },
            { id: 'evt-2', status: 'cancelled' },
          ],
          nextSyncToken: 'sync-2',
        },
      ],
      calls,
    );
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      yield* engine.syncAll();

      const window = yield* (yield* EventRepo).getWindow(0, plainDateToUtcMs('2030-01-01'));
      expect(window.singles).toHaveLength(1);
      expect(window.singles[0]!.title).toBe('Moved');
      expect(calls[1]!.syncToken).toBe('sync-1');
    }).pipe(Effect.provide(engineLayer(client)));
  });

  it.effect('410 triggers a full resync that purges stale rows', () => {
    const client = stubClient([
      // Pass 1: initial with two events.
      {
        items: [timedItem('evt-old', 10), timedItem('evt-keep', 12)],
        nextSyncToken: 'sync-1',
      },
      // Pass 2: incremental fails with 410…
      'sync-token-expired',
      // …then the full resync only returns evt-keep.
      { items: [timedItem('evt-keep', 12)], nextSyncToken: 'sync-2' },
    ]);
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      // The purge compares synced_at against the pass start — advance time
      // so the second pass is distinguishable from the first.
      yield* TestClock.adjust('5 minutes');
      yield* engine.syncAll();

      const window = yield* (yield* EventRepo).getWindow(0, plainDateToUtcMs('2030-01-01'));
      expect(window.singles.map((event) => event.id)).toEqual(['evt-keep']);

      const state = yield* (yield* SyncStateRepo).get('acc-1', eventsScope('cal-1'));
      expect(state?.syncToken).toBe('sync-2');
    }).pipe(Effect.provide(engineLayer(client)));
  });

  it.effect('a calendar-list 410 relists in full and drops what Google no longer has', () => {
    // A full list never reports a deletion: the purge has to know the
    // incremental pass fell back to one, or a calendar removed meanwhile
    // stays for good.
    const extra = { accessRole: 'owner' as const, id: 'cal-old', selected: true, summary: 'Old' };
    let listsOld = true;
    let tokenExpired = false;
    const calls: Array<string> = [];
    const client: GoogleCalendarClientShape = {
      ...stubClient([]),
      listCalendars: (params) => {
        calls.push(params.syncToken ?? 'full');
        if (params.syncToken && tokenExpired) {
          return Effect.fail(new SyncTokenExpiredError({ calendarId: '' }));
        }
        return Effect.succeed(
          params.syncToken
            ? { items: [], nextSyncToken: 'cal-sync-n' }
            : {
                items: [...(calendarListPage.items ?? []), ...(listsOld ? [extra] : [])],
                nextSyncToken: 'cal-sync-1',
              },
        );
      },
    };
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      const ids = Effect.map((yield* CalendarRepo).list('acc-1'), (rows) =>
        rows.map((row) => row.id).sort(),
      );
      yield* engine.syncAll();
      expect(yield* ids).toEqual(['cal-1', 'cal-old']);

      listsOld = false;
      tokenExpired = true;
      yield* engine.syncAll();
      expect(calls).toEqual(['full', 'cal-sync-1', 'full']);
      expect(yield* ids).toEqual(['cal-1']);
    }).pipe(Effect.provide(engineLayer(client)));
  });

  it.effect('offline, a pass gives up after one retry; a 503 still gets five', () => {
    // An unreached request (no status) used to be retried five times, about
    // half a minute per account with the sync gate held.
    let failure = new ApiUnavailableError({ cause: 'offline' });
    let colorCalls = 0;
    const client: GoogleCalendarClientShape = {
      ...stubClient([]),
      getColors: () =>
        Effect.suspend(() => {
          colorCalls += 1;
          return Effect.fail(failure);
        }),
    };
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      const run = () =>
        Effect.gen(function* () {
          colorCalls = 0;
          const fiber = yield* Effect.forkChild(Effect.ignore(engine.syncAll()));
          yield* TestClock.adjust('5 minutes');
          yield* Fiber.join(fiber);
          return colorCalls;
        });
      expect(yield* run()).toBe(2);
      failure = new ApiUnavailableError({ cause: 'http 503', status: 503 });
      expect(yield* run()).toBe(6);
    }).pipe(Effect.provide(engineLayer(client)));
  });

  describe('an events.list 404', () => {
    const goneEntry = {
      accessRole: 'owner' as const,
      id: 'cal-gone',
      selected: true,
      summary: 'A deleted one',
    };
    const tasksEnabledAccount = Effect.gen(function* () {
      yield* (yield* AccountRepo).upsert(
        new Account({
          contactsEnabled: false,
          createdAt: 1,
          email: 'nik@example.com',
          id: 'acc-1',
          provider: 'google',
          status: 'ok',
          tasksEnabled: true,
        }),
      );
    });

    it.effect(
      'skips the calendar, not the account; a full relist drops it once Google does',
      () => {
        // calendarList names a deleted calendar for minutes while its events
        // already 404. Sorted first ("A…" < "Personal"), it used to fail the
        // whole account pass: the calendars after it and tasks never synced.
        let googleListsIt = true;
        const calls: Array<string> = [];
        const client: GoogleCalendarClientShape = {
          ...stubClient([]),
          listCalendars: calendarList(
            () => [...(calendarListPage.items ?? []), ...(googleListsIt ? [goneEntry] : [])],
            calls,
          ),
          listEvents: ({ calendarId }) =>
            calendarId === 'cal-gone'
              ? Effect.fail(new NotFoundError({ resource: calendarId }))
              : Effect.succeed({ items: [timedItem('evt-1', 10)], nextSyncToken: 'evt-sync-1' }),
        };
        const tasksClient: GoogleTasksClientShape = {
          ...stubTasksClient,
          listTaskLists: () => Effect.succeed({ items: [{ id: 'list-1', title: 'My Tasks' }] }),
          listTasks: () =>
            Effect.succeed({ items: [{ id: 't1', status: 'needsAction', title: 'Pay rent' }] }),
        };
        return Effect.gen(function* () {
          yield* tasksEnabledAccount;
          const engine = yield* SyncEngine;
          const calendars = yield* CalendarRepo;
          const state = yield* SyncStateRepo;
          const ids = Effect.map(calendars.list('acc-1'), (rows) => rows.map((row) => row.id));

          yield* engine.syncAll();
          expect(yield* ids).toEqual(['cal-gone', 'cal-1']);
          expect((yield* state.get('acc-1', eventsScope('cal-1')))?.syncToken).toBe('evt-sync-1');
          expect(yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-1')).not.toBeNull();
          expect((yield* (yield* TaskRepo).listLists('acc-1')).map((list) => list.id)).toEqual([
            'list-1',
          ]);

          // Still listed: the full relist keeps it, and it 404s again.
          yield* engine.syncAll();
          expect(yield* ids).toEqual(['cal-gone', 'cal-1']);

          googleListsIt = false;
          yield* engine.syncAll();
          expect(yield* ids).toEqual(['cal-1']);
          expect(yield* state.get('acc-1', eventsScope('cal-gone'))).toBeNull();
          // Each pass after a 404 lists in full; a delta would never say.
          expect(calls).toEqual(['full', 'full', 'full']);
          yield* engine.syncAll();
          expect(calls.at(-1)).toBe('cal-sync-1');
        }).pipe(Effect.provide(engineLayer(client, tasksClient)));
      },
    );

    it.effect('that is transient keeps the calendar and its events; the next pass recovers', () => {
      const calls: Array<string> = [];
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          { items: [timedItem('evt-1', 10)], nextSyncToken: 'evt-sync-1' },
          'not-found',
          { items: [timedItem('evt-2', 12)], nextSyncToken: 'evt-sync-2' },
        ]),
        listCalendars: calendarList(() => calendarListPage.items, calls),
      };
      return Effect.gen(function* () {
        yield* seedAccount;
        const engine = yield* SyncEngine;
        const events = yield* EventRepo;
        yield* engine.syncAll();
        yield* engine.syncAll();
        // The 404 pass keeps what it had…
        expect((yield* (yield* CalendarRepo).list('acc-1')).map((row) => row.id)).toEqual([
          'cal-1',
        ]);
        expect(yield* events.getById('acc-1', 'cal-1', 'evt-1')).not.toBeNull();
        // …and the next one relists calendars in full (a delta would omit
        // the unchanged calendar) and resumes its events on the old token.
        yield* engine.syncAll();
        expect(calls).toEqual(['full', 'cal-sync-1', 'full']);
        expect(yield* events.getById('acc-1', 'cal-1', 'evt-2')).not.toBeNull();
        const state = yield* (yield* SyncStateRepo).get('acc-1', eventsScope('cal-1'));
        expect(state?.syncToken).toBe('evt-sync-2');
      }).pipe(Effect.provide(engineLayer(client)));
    });
  });

  it.effect('flags the account when Google demands re-auth', () => {
    const client = stubClient(['reauth']);
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      yield* engine.syncAll();

      const accounts = yield* (yield* AccountRepo).list();
      expect(accounts[0]!.status).toBe('reauth_required');
    }).pipe(Effect.provide(engineLayer(client)));
  });
});
