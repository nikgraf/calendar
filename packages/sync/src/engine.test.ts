import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import {
  Account,
  assembleWindow,
  Attendee,
  EventRecord,
  eventsScope,
  plainDateToUtcMs,
} from '@calendar/core';
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
  ConflictError,
  type GcalCalendarListPage,
  type GcalEvent,
  type GcalEventInput,
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
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
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
): GoogleCalendarClientShape => ({
  deleteEvent: () => Effect.die('not used'),
  getColors: () => Effect.succeed({ calendar: {} }),
  getEvent: () => Effect.die('unexpected get'),
  insertCalendar: () => Effect.die('not used'),
  insertEvent: () => Effect.die('not used'),
  listCalendars: () => Effect.succeed(calendarListPage),
  listEvents: () => {
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
  moveTask: () => Effect.die('tasks not enabled in this test'),
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

/**
 * The second pass's page waits for `release` and still names evt-1
 * (changed elsewhere since the token). Applied after a local delete, such
 * a page put the row back; the delete landed and left that copy showing
 * until the next poll's delta reported the cancellation (google-live
 * 40265233306, iOS flow 02).
 */
const heldPass = (deleteEvent: GoogleCalendarClientShape['deleteEvent']) => {
  const requested = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<void>());
  let calls = 0;
  const client: GoogleCalendarClientShape = {
    ...stubClient([]),
    deleteEvent,
    listEvents: ({ calendarId }) => {
      if (calendarId !== 'cal-1') {
        return Effect.succeed({ items: [], nextSyncToken: 's1' });
      }
      calls += 1;
      if (calls === 1) {
        return Effect.succeed({ items: [timedItem('evt-1', 10)], nextSyncToken: 's1' });
      }
      if (calls === 2) {
        const changed = { ...timedItem('evt-1', 10), etag: '"evt-1-2"', summary: 'All day' };
        return Deferred.succeed(requested, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ items: [changed], nextSyncToken: 's2' }),
        );
      }
      return Effect.succeed({ items: [], nextSyncToken: 's3' });
    },
  };
  return { client, release, requested };
};

/** Deletes evt-1 while the second pass waits for its page, then lets the page in. */
const deleteDuringPass = (pass: ReturnType<typeof heldPass>) =>
  Effect.gen(function* () {
    yield* seedAccount;
    const engine = yield* SyncEngine;
    const mutations = yield* EventMutations;
    yield* engine.syncAll();
    const syncing = yield* Effect.forkChild(engine.syncAll());
    yield* Deferred.await(pass.requested);
    yield* mutations.deleteEvent({ accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-1' });
    // The drain the delete kicked: free to land the delete ahead of the
    // page unless the pass holds the queue.
    const draining = yield* Effect.forkChild(mutations.processPendingOps());
    for (let turn = 0; turn < 50; turn += 1) {
      yield* Effect.yieldNow;
    }
    yield* Deferred.succeed(pass.release, undefined);
    yield* Fiber.join(syncing);
    yield* Fiber.join(draining);
    return yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-1');
  });

/** A delete that meets a 503 first, then `then`. */
const failingOnce = (then: Effect.Effect<void, NotFoundError>) => {
  let attempts = 0;
  return () =>
    attempts++ === 0 ? Effect.fail(new ApiUnavailableError({ cause: 'offline' })) : then;
};

/**
 * Lands the delete deleteDuringPass left in backoff, after `change`
 * rewrote the copy the page put back; the row at evt-1 afterwards.
 */
const landDeleteAfter = (change: (row: EventRecord) => EventRecord) =>
  Effect.gen(function* () {
    const events = yield* EventRepo;
    const copy = yield* events.getById('acc-1', 'cal-1', 'evt-1');
    // Until it lands Google's copy shows, as for any delete still queued.
    expect(copy?.title).toBe('All day');
    yield* events.upsertMany([change(copy!)]);
    const mutations = yield* EventMutations;
    yield* mutations.retryPendingOps();
    yield* mutations.processPendingOps();
    expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
    return yield* events.getById('acc-1', 'cal-1', 'evt-1');
  });

/** evt-r's July 3 occurrence, moved to 12:00 on Google. */
const movedOccurrence = (summary: string, etag: string) => ({
  end: { dateTime: '2026-07-03T13:00:00Z' },
  etag,
  id: 'evt-r_20260703T100000Z',
  originalStartTime: { dateTime: '2026-07-03T10:00:00Z' },
  recurringEventId: 'evt-r',
  start: { dateTime: '2026-07-03T12:00:00Z' },
  status: 'confirmed',
  summary,
});

/** The same occurrence as an invitation, `response` the account's answer. */
const invitedOccurrence = (summary: string, etag: string, response: string) => ({
  ...movedOccurrence(summary, etag),
  attendees: [
    { email: 'nik@example.com', responseStatus: response, self: true },
    { email: 'host@example.com', organizer: true, responseStatus: 'accepted' },
  ],
  organizer: { email: 'host@example.com' },
});

/** A delete that meets a 412 first (Google changed the event), then `then`. */
const parkedThen = (then: () => ReturnType<GoogleCalendarClientShape['deleteEvent']>) => {
  let attempts = 0;
  return ({ calendarId, eventId }: { calendarId: string; eventId: string }) =>
    attempts++ === 0 ? Effect.fail(new ConflictError({ calendarId, eventId })) : then();
};

/** A series' rows nothing would ever settle: pending, with no op of theirs queued. */
const straysOf = (masterId: string) =>
  Effect.gen(function* () {
    const events = yield* EventRepo;
    const ops = yield* PendingOpRepo;
    const master = yield* events.getById('acc-1', 'cal-1', masterId);
    const rows = [
      ...(master ? [master] : []),
      ...(yield* events.listOverrides('acc-1', 'cal-1', masterId)),
    ];
    const stray: Array<string> = [];
    for (const row of rows) {
      const owners = yield* ops.listForEvent({ ...row, eventId: row.id });
      if (row.syncStatus === 'pending' && owners.length === 0) {
        stray.push(row.id);
      }
    }
    return stray;
  });

/** The queued op of one kind for an event. */
const opOf = (eventId: string, kind: string) =>
  Effect.gen(function* () {
    const ops = yield* (yield* PendingOpRepo).listAll();
    return ops.find((op) => op.eventId === eventId && op.kind === kind);
  });

/** Online from `online`: what reached Google's DELETE. */
const deleting = (online: () => boolean) => {
  const deleted: Array<string> = [];
  const deleteEvent: GoogleCalendarClientShape['deleteEvent'] = ({ eventId }) => {
    if (!online()) {
      return Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
    }
    deleted.push(eventId);
    return Effect.void;
  };
  return { deleted, deleteEvent };
};

/** Google's answer to a request made offline. */
const offline = () => Effect.fail(new ApiUnavailableError({ cause: 'offline' }));

/** Google's answer to an If-Match that no longer matches. */
const conflict = ({ calendarId, eventId }: { calendarId: string; eventId: string }) =>
  Effect.fail(new ConflictError({ calendarId, eventId }));

/** Google's copy of an event it inserted. */
const insertedCopy = (event: GcalEventInput): GcalEvent => ({
  end: event.end,
  etag: `"${event.id}-1"`,
  id: event.id ?? 'inserted',
  recurrence: event.recurrence,
  start: event.start,
  status: 'confirmed',
  summary: event.summary,
});

/** Online from `online`: the titles of the events that reached Google's insert. */
const inserting = (online: () => boolean) => {
  const inserted: Array<string | undefined> = [];
  const insertEvent: GoogleCalendarClientShape['insertEvent'] = ({ event }) => {
    if (!online()) {
      return Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
    }
    inserted.push(event.summary);
    return Effect.succeed(insertedCopy(event));
  };
  return { inserted, insertEvent };
};

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

  it.effect('a pull that confirms a deletion leaves a queued delete nothing to put back', () => {
    const client: GoogleCalendarClientShape = {
      ...stubClient([
        { items: [timedItem('evt-1', 10)], nextSyncToken: 's1' },
        // Deleted on Google by another client while the local delete waited.
        { items: [{ id: 'evt-1', status: 'cancelled' }], nextSyncToken: 's2' },
      ]),
      deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
    };
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      const mutations = yield* EventMutations;
      const events = yield* EventRepo;
      yield* engine.syncAll();
      yield* mutations.deleteEvent({ accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-1' });
      const ops = yield* PendingOpRepo;
      expect((yield* ops.listAll())[0]?.beforePayload?.title).toBe('Event evt-1');

      yield* engine.syncAll();
      const [op] = yield* ops.listAll();
      expect(op?.kind).toBe('delete');
      expect(op?.beforePayload).toBeUndefined();
      // Discarding it now must not bring back an event Google removed: the
      // sync token has seen the deletion and will never send it again.
      yield* mutations.discardPendingOp(op!.id);
      expect(yield* events.getById('acc-1', 'cal-1', 'evt-1')).toBeNull();
    }).pipe(Effect.provide(engineLayer(client)));
  });

  it.effect(
    'a pull that confirms an occurrence cancelled leaves its queued delete nothing to put back',
    () => {
      const series = { ...timedItem('evt-r', 10), recurrence: ['RRULE:FREQ=DAILY;COUNT=5'] };
      const instanceId = 'evt-r_20260703T100000Z';
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          { items: [series], nextSyncToken: 's1' },
          // Another client cancelled the same occurrence meanwhile.
          {
            items: [
              {
                id: instanceId,
                originalStartTime: { dateTime: '2026-07-03T10:00:00Z' },
                recurringEventId: 'evt-r',
                status: 'cancelled',
              },
            ],
            nextSyncToken: 's2',
          },
        ]),
        deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* seedAccount;
        const engine = yield* SyncEngine;
        const mutations = yield* EventMutations;
        const events = yield* EventRepo;
        yield* engine.syncAll();
        yield* mutations.deleteRecurring({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          masterId: 'evt-r',
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'instance',
        });
        const ops = yield* PendingOpRepo;
        expect((yield* ops.listAll())[0]?.beforePayload).toBeNull();

        yield* engine.syncAll();
        const [op] = yield* ops.listAll();
        expect(op?.beforePayload).toBeUndefined();
        yield* mutations.discardPendingOp(op!.id);
        // The tombstone stays: the occurrence is gone on Google for good.
        expect((yield* events.getById('acc-1', 'cal-1', instanceId))?.status).toBe('cancelled');
      }).pipe(Effect.provide(engineLayer(client)));
    },
  );

  it.effect(
    'an exception a pull re-sends while its occurrence delete waits is what a discard puts back',
    () => {
      const series = { ...timedItem('evt-r', 10), recurrence: ['RRULE:FREQ=DAILY;COUNT=5'] };
      const instanceId = 'evt-r_20260703T100000Z';
      const exception = (summary: string, etag: string) => ({
        end: { dateTime: '2026-07-03T13:00:00Z' },
        etag,
        id: instanceId,
        originalStartTime: { dateTime: '2026-07-03T10:00:00Z' },
        recurringEventId: 'evt-r',
        start: { dateTime: '2026-07-03T12:00:00Z' },
        status: 'confirmed',
        summary,
      });
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          { items: [series, exception('Moved', '"x-1"')], nextSyncToken: 's1' },
          // Another client renamed the exception meanwhile.
          { items: [exception('Moved again', '"x-2"')], nextSyncToken: 's2' },
        ]),
        deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* seedAccount;
        const engine = yield* SyncEngine;
        const mutations = yield* EventMutations;
        const events = yield* EventRepo;
        yield* engine.syncAll();
        yield* mutations.deleteRecurring({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          masterId: 'evt-r',
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'instance',
        });
        const ops = yield* PendingOpRepo;
        expect((yield* ops.listAll())[0]?.beforePayload?.title).toBe('Moved');

        yield* engine.syncAll();
        // The pull leaves the tombstone, the user's own, as it is.
        expect((yield* events.getById('acc-1', 'cal-1', instanceId))?.status).toBe('cancelled');
        const [op] = yield* ops.listAll();
        expect(op?.beforePayload?.title).toBe('Moved again');
        // Still sent on the etag the user deleted: Google's change parks it.
        expect(op?.baseEtag).toBe('"x-1"');
        yield* mutations.discardPendingOp(op!.id);
        expect((yield* events.getById('acc-1', 'cal-1', instanceId))?.title).toBe('Moved again');
      }).pipe(Effect.provide(engineLayer(client)));
    },
  );

  describe('a page answered before a delete reached Google', () => {
    it.effect('a delete that lands meanwhile stays deleted', () => {
      const deleted: Array<string> = [];
      const pass = heldPass(({ eventId }) => {
        deleted.push(eventId);
        return Effect.void;
      });
      return Effect.gen(function* () {
        expect(yield* deleteDuringPass(pass)).toBeNull();
        expect(deleted).toEqual(['evt-1']);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }).pipe(Effect.provide(engineLayer(pass.client)));
    });

    it.effect('a delete that waits out a 503 takes the page’s copy with it once it lands', () => {
      const pass = heldPass(failingOnce(Effect.void));
      return Effect.gen(function* () {
        yield* deleteDuringPass(pass);
        expect(yield* landDeleteAfter((row) => row)).toBeNull();
      }).pipe(Effect.provide(engineLayer(pass.client)));
    });

    it.effect('a delete answered 404 (an earlier attempt landed) takes it too', () => {
      const pass = heldPass(failingOnce(Effect.fail(new NotFoundError({ resource: 'evt-1' }))));
      return Effect.gen(function* () {
        yield* deleteDuringPass(pass);
        expect(yield* landDeleteAfter((row) => row)).toBeNull();
      }).pipe(Effect.provide(engineLayer(pass.client)));
    });

    it.effect('a landing delete leaves a row an op queued since owns', () => {
      const pass = heldPass(failingOnce(Effect.void));
      return Effect.gen(function* () {
        yield* deleteDuringPass(pass);
        const row = yield* landDeleteAfter(
          (copy) => new EventRecord({ ...copy, syncStatus: 'pending' }),
        );
        expect(row?.syncStatus).toBe('pending');
      }).pipe(Effect.provide(engineLayer(pass.client)));
    });

    it.effect('a landing delete leaves a cancelled override', () => {
      const pass = heldPass(failingOnce(Effect.void));
      return Effect.gen(function* () {
        yield* deleteDuringPass(pass);
        const row = yield* landDeleteAfter(
          (copy) => new EventRecord({ ...copy, status: 'cancelled' }),
        );
        expect(row?.status).toBe('cancelled');
      }).pipe(Effect.provide(engineLayer(pass.client)));
    });

    // Re-queued behind the move, the delete removed the moved event on
    // Google after all, and its pending row showed in the target until the
    // next pull reported the deletion.
    it.effect('a move of the copy replaces the delete: the event lands in the target', () => {
      let deletes = 0;
      const moves: Array<string> = [];
      const pass = heldPass(
        failingOnce(
          Effect.sync(() => {
            deletes += 1;
          }),
        ),
      );
      const client: GoogleCalendarClientShape = {
        ...pass.client,
        listCalendars: () =>
          Effect.succeed({
            items: [
              ...(calendarListPage.items ?? []),
              { accessRole: 'owner', id: 'cal-2', selected: true, summary: 'Work' },
            ],
            nextSyncToken: 'cal-sync-1',
          }),
        moveEvent: ({ calendarId, destination, eventId }) =>
          Effect.sync(() => {
            moves.push(`${calendarId} → ${destination}`);
            return { ...timedItem(eventId, 10), etag: '"evt-1-3"', summary: 'All day' };
          }),
      };
      return Effect.gen(function* () {
        yield* deleteDuringPass(pass);
        const mutations = yield* EventMutations;
        yield* mutations.moveEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          eventId: 'evt-1',
          target: { accountId: 'acc-1', calendarId: 'cal-2' },
        });
        yield* mutations.processPendingOps();
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();

        expect(moves).toEqual(['cal-1 → cal-2']);
        expect(deletes).toBe(0);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        const events = yield* EventRepo;
        expect(yield* events.getById('acc-1', 'cal-1', 'evt-1')).toBeNull();
        expect((yield* events.getById('acc-1', 'cal-2', 'evt-1'))?.syncStatus).toBe('synced');
      }).pipe(Effect.provide(engineLayer(client)));
    });

    // Sent while the delete waited out its backoff, the answer landed first
    // and kept the row pending for the delete, which then deleted the event.
    it.effect('an answer to the copy replaces the delete as well', () => {
      let deletes = 0;
      const pass = heldPass(
        failingOnce(
          Effect.sync(() => {
            deletes += 1;
          }),
        ),
      );
      const client: GoogleCalendarClientShape = {
        ...pass.client,
        patchEvent: ({ eventId }) =>
          Effect.succeed({
            ...timedItem(eventId, 10),
            attendees: [
              { email: 'nik@example.com', responseStatus: 'accepted', self: true },
              { email: 'host@example.com', organizer: true, responseStatus: 'accepted' },
            ],
            etag: '"evt-1-3"',
            summary: 'All day',
          }),
      };
      return Effect.gen(function* () {
        yield* deleteDuringPass(pass);
        const events = yield* EventRepo;
        // The page's copy carries an invitation to answer.
        const copy = yield* events.getById('acc-1', 'cal-1', 'evt-1');
        yield* events.upsertMany([
          new EventRecord({
            ...copy!,
            attendees: [
              new Attendee({
                email: 'nik@example.com',
                isSelf: true,
                responseStatus: 'needsAction',
              }),
              new Attendee({
                email: 'host@example.com',
                isOrganizer: true,
                responseStatus: 'accepted',
              }),
            ],
            organizerEmail: 'host@example.com',
          }),
        ]);
        const mutations = yield* EventMutations;
        yield* mutations.respondToEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          eventId: 'evt-1',
          response: 'accepted',
        });
        yield* mutations.processPendingOps();
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();

        expect(deletes).toBe(0);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        const row = yield* events.getById('acc-1', 'cal-1', 'evt-1');
        expect(row?.syncStatus).toBe('synced');
        expect(row?.attendees?.find((guest) => guest.isSelf)?.responseStatus).toBe('accepted');
      }).pipe(Effect.provide(engineLayer(client)));
    });
  });

  describe('a series whose delete waits', () => {
    // July 2–6 at 10:00; July 3 moved to 12:00 on Google, July 4 cancelled there.
    const series = { ...timedItem('evt-r', 10), recurrence: ['RRULE:FREQ=DAILY;COUNT=5'] };
    const renamed = { ...series, etag: '"evt-r-2"', summary: 'Daily (Google)' };
    const cancelled = {
      id: 'evt-r_20260704T100000Z',
      originalStartTime: { dateTime: '2026-07-04T10:00:00Z' },
      recurringEventId: 'evt-r',
      status: 'cancelled',
    };
    const firstPage = {
      items: [series, movedOccurrence('Moved', '"x-1"'), cancelled],
      nextSyncToken: 's1',
    };

    /** What the calendar draws: "MM-DDTHH:MM title" per event. */
    const shown = Effect.gen(function* () {
      const from = Date.parse('2026-07-01T00:00:00Z');
      const to = Date.parse('2026-07-08T00:00:00Z');
      const window = yield* (yield* EventRepo).getWindow(from, to);
      return assembleWindow(window, from, to).map(
        (event) => `${new Date(event.startUtc).toISOString().slice(5, 16)} ${event.title}`,
      );
    });
    const googleSeries = [
      '07-02T10:00 Daily (Google)',
      '07-03T12:00 Moved',
      '07-05T10:00 Daily (Google)',
      '07-06T10:00 Daily (Google)',
    ];

    /** The first pass, then the series delete, which meets `deleteEvent` on the next push. */
    const syncThenDelete = Effect.gen(function* () {
      yield* seedAccount;
      yield* (yield* SyncEngine).syncAll();
      yield* (yield* EventMutations).deleteRecurring({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        masterId: 'evt-r',
        originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
        scope: 'series',
      });
      expect(yield* shown).toEqual([]);
    });
    const seriesDelete = Effect.gen(function* () {
      const ops = yield* (yield* PendingOpRepo).listAll();
      return ops.find((op) => op.eventId === 'evt-r' && op.kind === 'delete');
    });
    const july3 = 'evt-r_20260703T100000Z';
    /** "July 3 and following" (July 3's and July 4's own deletes), then the whole series. */
    const cutThenDelete = Effect.gen(function* () {
      const mutations = yield* EventMutations;
      const cut = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
      yield* mutations.deleteRecurring({
        ...cut,
        originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
        scope: 'following',
      });
      yield* mutations.deleteRecurring({
        ...cut,
        originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
        scope: 'series',
      });
    });
    const strays = straysOf('evt-r');

    it.effect('a pull that puts the master back brings back the exceptions the delete took', () => {
      // An incremental pull re-sends the master, renamed on Google, and not
      // its exceptions, which did not change: July 3 showed at 10:00 and
      // July 4's slot showed too.
      const client: GoogleCalendarClientShape = {
        ...stubClient([firstPage, { items: [renamed], nextSyncToken: 's2' }]),
        deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        yield* (yield* SyncEngine).syncAll();
        expect(yield* shown).toEqual(googleSeries);
        // They are Google's copies now, like the master: the delete holds none.
        const op = yield* seriesDelete;
        expect(op?.beforeOverrides).toBeUndefined();

        yield* (yield* EventMutations).discardPendingOp(op!.id);
        expect(yield* shown).toEqual(googleSeries);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('once that delete lands, they go with the series', () => {
      let online = false;
      const client: GoogleCalendarClientShape = {
        ...stubClient([firstPage, { items: [renamed], nextSyncToken: 's2' }]),
        deleteEvent: () =>
          online ? Effect.void : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        yield* (yield* SyncEngine).syncAll();
        expect(yield* shown).toEqual(googleSeries);

        online = true;
        const mutations = yield* EventMutations;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        expect(yield* shown).toEqual([]);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('a pull that reports the series deleted on Google takes them away with it', () => {
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          firstPage,
          { items: [renamed], nextSyncToken: 's2' },
          { items: [{ id: 'evt-r', status: 'cancelled' }], nextSyncToken: 's3' },
        ]),
        deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        const engine = yield* SyncEngine;
        yield* engine.syncAll();
        expect(yield* shown).toEqual(googleSeries);
        // The delete waits out its backoff meanwhile.
        yield* engine.syncAll();
        expect(yield* shown).toEqual([]);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect(
      'one put back while its own delete (a cut’s) waits goes when that delete lands',
      () => {
        let online = false;
        const client: GoogleCalendarClientShape = {
          ...stubClient([
            firstPage,
            { items: [movedOccurrence('Moved again', '"x-2"')], nextSyncToken: 's2' },
            { items: [renamed], nextSyncToken: 's3' },
          ]),
          deleteEvent: () =>
            online ? Effect.void : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          const mutations = yield* EventMutations;
          yield* engine.syncAll();
          // "July 3 and following" queues July 3's own delete; the series
          // delete after it no longer finds that row to take.
          const cut = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
          yield* mutations.deleteRecurring({
            ...cut,
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'following',
          });
          yield* mutations.deleteRecurring({
            ...cut,
            originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
            scope: 'series',
          });
          yield* engine.syncAll();
          yield* engine.syncAll();

          online = true;
          yield* mutations.retryPendingOps();
          yield* mutations.processPendingOps();
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
          // Put back pending, as if that delete owned the row, it stayed for good.
          expect(yield* shown).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      },
    );

    it.effect('one an answer and a cut’s delete both wait on goes back synced', () => {
      let online = false;
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          {
            ...firstPage,
            items: [series, invitedOccurrence('Moved', '"x-1"', 'needsAction'), cancelled],
          },
          {
            items: [invitedOccurrence('Moved again', '"x-2"', 'needsAction')],
            nextSyncToken: 's2',
          },
          { items: [renamed], nextSyncToken: 's3' },
        ]),
        deleteEvent: () =>
          online ? Effect.void : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        patchEvent: () =>
          online
            ? Effect.succeed(invitedOccurrence('Moved again', '"x-3"', 'accepted'))
            : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* seedAccount;
        const engine = yield* SyncEngine;
        const mutations = yield* EventMutations;
        yield* engine.syncAll();
        const cut = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
        yield* mutations.respondToEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          eventId: 'evt-r_20260703T100000Z',
          response: 'accepted',
        });
        yield* mutations.deleteRecurring({
          ...cut,
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'following',
        });
        yield* mutations.deleteRecurring({
          ...cut,
          originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
          scope: 'series',
        });
        yield* engine.syncAll();
        yield* engine.syncAll();

        online = true;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        // Pending, neither the answer's ack nor the delete settled it.
        expect(yield* shown).toEqual([]);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('a copy a pull sends over a row there goes to that row, as before', () => {
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          firstPage,
          { items: [movedOccurrence('Moved again', '"x-2"')], nextSyncToken: 's2' },
        ]),
        deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        // A synced row without its master, as a discarded cut's exception
        // delete wrote back before it went into the series delete instead.
        const taken = (yield* seriesDelete)!.beforeOverrides!.find((row) => row.id === july3);
        yield* (yield* EventRepo).upsertMany([taken!]);

        yield* (yield* SyncEngine).syncAll();
        yield* (yield* EventMutations).discardPendingOp((yield* seriesDelete)!.id);
        const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', july3);
        // Held in the delete instead, the row kept its stale title for good.
        expect(row?.title).toBe('Moved again');
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('a copy held in the delete is what the cut’s own delete puts back too', () => {
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          firstPage,
          { items: [movedOccurrence('Moved again', '"x-2"')], nextSyncToken: 's2' },
        ]),
        deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* seedAccount;
        const engine = yield* SyncEngine;
        const mutations = yield* EventMutations;
        yield* engine.syncAll();
        const cut = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
        yield* mutations.deleteRecurring({
          ...cut,
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'following',
        });
        yield* mutations.deleteRecurring({
          ...cut,
          originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
          scope: 'series',
        });
        yield* engine.syncAll();

        const own = (yield* (yield* PendingOpRepo).listAll()).find(
          (op) => op.eventId === 'evt-r_20260703T100000Z',
        );
        yield* mutations.discardPendingOp(own!.id);
        yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
        const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-r_20260703T100000Z');
        // The cut's delete still held the copy from before the pull.
        expect(row?.title).toBe('Moved again');
        expect(row?.etag).toBe('"x-2"');
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('and so is one keep-mine takes back', () => {
      let parked = false;
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          firstPage,
          // The master comes back with July 3, changed on Google.
          { items: [renamed, movedOccurrence('Moved again', '"x-2"')], nextSyncToken: 's2' },
        ]),
        deleteEvent: ({ calendarId, eventId }) => {
          if (eventId === 'evt-r' && !parked) {
            parked = true;
            return Effect.fail(new ConflictError({ calendarId, eventId }));
          }
          return Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
        },
        getEvent: () => Effect.succeed(renamed),
      };
      return Effect.gen(function* () {
        yield* seedAccount;
        const engine = yield* SyncEngine;
        const mutations = yield* EventMutations;
        yield* engine.syncAll();
        const cut = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
        yield* mutations.deleteRecurring({
          ...cut,
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'following',
        });
        yield* mutations.deleteRecurring({
          ...cut,
          originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
          scope: 'series',
        });
        yield* engine.syncAll();
        yield* mutations.resolveConflict({ choice: 'mine', opId: (yield* seriesDelete)!.id });

        const own = (yield* (yield* PendingOpRepo).listAll()).find(
          (op) => op.eventId === 'evt-r_20260703T100000Z',
        );
        yield* mutations.discardPendingOp(own!.id);
        yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
        const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-r_20260703T100000Z');
        expect(row?.title).toBe('Moved again');
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('a copy over an occurrence delete’s tombstone is still that delete’s', () => {
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          firstPage,
          { items: [renamed], nextSyncToken: 's2' },
          { items: [movedOccurrence('Moved again', '"x-2"')], nextSyncToken: 's3' },
        ]),
        deleteEvent: parkedThen(() => Effect.fail(new ApiUnavailableError({ cause: 'offline' }))),
        getEvent: () => Effect.succeed(renamed),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        const engine = yield* SyncEngine;
        const mutations = yield* EventMutations;
        yield* engine.syncAll();
        yield* mutations.deleteRecurring({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          masterId: 'evt-r',
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'instance',
        });
        yield* mutations.resolveConflict({ choice: 'mine', opId: (yield* seriesDelete)!.id });

        yield* engine.syncAll();
        const own = (yield* (yield* PendingOpRepo).listAll()).find(
          (op) => op.eventId === 'evt-r_20260703T100000Z',
        );
        expect(own?.beforePayload?.title).toBe('Moved again');
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('keep-mine takes back a copy whose own delete waits', () => {
      let online = false;
      let parked = false;
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          firstPage,
          { items: [movedOccurrence('Moved again', '"x-2"')], nextSyncToken: 's2' },
          { items: [renamed], nextSyncToken: 's3' },
        ]),
        deleteEvent: ({ calendarId, eventId }) => {
          if (eventId === 'evt-r' && !parked) {
            parked = true;
            return Effect.fail(new ConflictError({ calendarId, eventId }));
          }
          return online ? Effect.void : Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
        },
        getEvent: () => Effect.succeed(renamed),
      };
      return Effect.gen(function* () {
        yield* seedAccount;
        const engine = yield* SyncEngine;
        const mutations = yield* EventMutations;
        yield* engine.syncAll();
        const cut = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
        yield* mutations.deleteRecurring({
          ...cut,
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'following',
        });
        yield* mutations.deleteRecurring({
          ...cut,
          originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
          scope: 'series',
        });
        yield* engine.syncAll();
        yield* engine.syncAll();
        expect(yield* shown).toContain('07-03T12:00 Moved again');

        yield* mutations.resolveConflict({ choice: 'mine', opId: (yield* seriesDelete)!.id });
        // Left on the table, July 3 showed without its series.
        expect(yield* shown).toEqual([]);
        online = true;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        expect(yield* shown).toEqual([]);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('an occurrence edit that lands after keep-mine leaves no row behind', () => {
      let deleteOnline = false;
      let patchOnline = false;
      let deletes = 0;
      const client: GoogleCalendarClientShape = {
        ...stubClient([firstPage, { items: [renamed], nextSyncToken: 's2' }]),
        deleteEvent: ({ calendarId, eventId }) =>
          deletes++ === 0
            ? Effect.fail(new ConflictError({ calendarId, eventId }))
            : deleteOnline
              ? Effect.void
              : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        getEvent: () => Effect.succeed(renamed),
        patchEvent: () =>
          patchOnline
            ? Effect.succeed({ ...movedOccurrence('Edited', '"x-2"') })
            : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        yield* (yield* SyncEngine).syncAll();
        const mutations = yield* EventMutations;
        yield* mutations.updateRecurring({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          changes: { title: 'Edited' },
          masterId: 'evt-r',
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'instance',
        });
        yield* mutations.resolveConflict({ choice: 'mine', opId: (yield* seriesDelete)!.id });

        // The edit lands while the delete waits out a 503, then the delete.
        patchOnline = true;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect((yield* (yield* PendingOpRepo).listAll()).map((op) => op.eventId)).toEqual([
          'evt-r',
        ]);
        deleteOnline = true;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        expect(yield* shown).toEqual([]);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('an exception a pull sends while the master is gone waits in the delete', () => {
      // Renamed on Google meanwhile; written as a row of its own, it showed
      // as an event without its series. July 5 is cancelled there too.
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          firstPage,
          {
            items: [
              movedOccurrence('Moved again', '"x-2"'),
              {
                id: 'evt-r_20260705T100000Z',
                originalStartTime: { dateTime: '2026-07-05T10:00:00Z' },
                recurringEventId: 'evt-r',
                status: 'cancelled',
              },
            ],
            nextSyncToken: 's2',
          },
        ]),
        deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        yield* (yield* SyncEngine).syncAll();
        expect(yield* shown).toEqual([]);

        // A discard brings it back as Google sent it.
        yield* (yield* EventMutations).discardPendingOp((yield* seriesDelete)!.id);
        expect(yield* shown).toEqual([
          '07-02T10:00 Event evt-r',
          '07-03T12:00 Moved again',
          '07-06T10:00 Event evt-r',
        ]);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('and comes back as sent once a pull puts the master back', () => {
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          firstPage,
          { items: [movedOccurrence('Moved again', '"x-2"')], nextSyncToken: 's2' },
          { items: [renamed], nextSyncToken: 's3' },
        ]),
        deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        const engine = yield* SyncEngine;
        yield* engine.syncAll();
        yield* engine.syncAll();
        expect(yield* shown).toEqual([
          '07-02T10:00 Daily (Google)',
          '07-03T12:00 Moved again',
          '07-05T10:00 Daily (Google)',
          '07-06T10:00 Daily (Google)',
        ]);
        const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-r_20260703T100000Z');
        expect(row?.etag).toBe('"x-2"');
        expect(row?.syncStatus).toBe('synced');
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('keep mine takes them back with the master’s copy', () => {
      const client: GoogleCalendarClientShape = {
        ...stubClient([firstPage, { items: [renamed], nextSyncToken: 's2' }]),
        deleteEvent: parkedThen(() => Effect.fail(new ApiUnavailableError({ cause: 'offline' }))),
        getEvent: () => Effect.succeed(renamed),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        // The push parks the delete; the pull puts Google's series back.
        yield* (yield* SyncEngine).syncAll();
        const parked = yield* seriesDelete;
        expect(parked?.conflictAt).toBeDefined();
        expect(yield* shown).toEqual(googleSeries);

        const mutations = yield* EventMutations;
        yield* mutations.resolveConflict({ choice: 'mine', opId: parked!.id });
        yield* mutations.processPendingOps();
        expect(yield* shown).toEqual([]);

        // Discarded while it waits: the series comes back as Google has it.
        yield* mutations.discardPendingOp(parked!.id);
        expect(yield* shown).toEqual(googleSeries);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('keep theirs, once Google deleted the series, takes them away with it', () => {
      let deletedOnGoogle = false;
      const client: GoogleCalendarClientShape = {
        ...stubClient([firstPage, { items: [renamed], nextSyncToken: 's2' }]),
        deleteEvent: parkedThen(() => Effect.die('unexpected delete')),
        getEvent: () =>
          deletedOnGoogle
            ? Effect.fail(new NotFoundError({ resource: 'evt-r' }))
            : Effect.succeed(renamed),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        yield* (yield* SyncEngine).syncAll();
        expect(yield* shown).toEqual(googleSeries);

        deletedOnGoogle = true;
        yield* (yield* EventMutations).resolveConflict({
          choice: 'theirs',
          opId: (yield* seriesDelete)!.id,
        });
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        expect(yield* shown).toEqual([]);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('an occurrence edit undone after keep-mine goes back into the delete', () => {
      const client: GoogleCalendarClientShape = {
        ...stubClient([firstPage, { items: [renamed], nextSyncToken: 's2' }]),
        deleteEvent: parkedThen(() => Effect.fail(new ApiUnavailableError({ cause: 'offline' }))),
        getEvent: () => Effect.succeed(renamed),
        patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        yield* (yield* SyncEngine).syncAll();
        const mutations = yield* EventMutations;
        yield* mutations.updateRecurring({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          changes: { title: 'Edited' },
          masterId: 'evt-r',
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'instance',
        });
        yield* mutations.resolveConflict({ choice: 'mine', opId: (yield* seriesDelete)!.id });
        // The user's own change stays until it lands or goes.
        expect(yield* shown).toEqual(['07-03T12:00 Edited']);

        yield* mutations.discardPendingOp((yield* opOf(july3, 'update'))!.id);
        // Written back as Google's copy, July 3 showed without its series.
        expect(yield* shown).toEqual([]);
        expect(yield* strays).toEqual([]);
        yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
        expect(yield* shown).toEqual(googleSeries);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect('and one an answer still waits on goes there for that answer to settle', () => {
      let online = false;
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          {
            ...firstPage,
            items: [series, invitedOccurrence('Moved', '"x-1"', 'needsAction'), cancelled],
          },
          { items: [renamed], nextSyncToken: 's2' },
        ]),
        deleteEvent: parkedThen(() => Effect.fail(new ApiUnavailableError({ cause: 'offline' }))),
        getEvent: () => Effect.succeed(renamed),
        patchEvent: () =>
          online
            ? Effect.succeed(invitedOccurrence('Moved', '"x-2"', 'accepted'))
            : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      return Effect.gen(function* () {
        yield* syncThenDelete;
        yield* (yield* SyncEngine).syncAll();
        const mutations = yield* EventMutations;
        yield* mutations.respondToEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          eventId: july3,
          response: 'accepted',
        });
        yield* mutations.updateRecurring({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          changes: { title: 'Edited' },
          masterId: 'evt-r',
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'instance',
        });
        yield* mutations.resolveConflict({ choice: 'mine', opId: (yield* seriesDelete)!.id });
        yield* mutations.discardPendingOp((yield* opOf(july3, 'update'))!.id);
        // Left pending for the answer, July 3 showed without its series.
        expect(yield* shown).toEqual([]);

        // The answer lands while the delete waits: Google's copy goes there.
        online = true;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect((yield* (yield* PendingOpRepo).listAll()).map((op) => op.eventId)).toEqual([
          'evt-r',
        ]);
        expect(yield* shown).toEqual([]);
        expect(yield* strays).toEqual([]);
        yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
        expect(yield* shown).toEqual(googleSeries);
        const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', july3);
        expect(row?.etag).toBe('"x-2"');
        expect(row?.attendees?.find((guest) => guest.isSelf)?.responseStatus).toBe('accepted');
      }).pipe(Effect.provide(engineLayer(client)));
    });

    // A pull puts the master back while the series delete waits, and
    // July 3's delete meets a 412: the user keeps theirs, which leaves
    // its tombstone at July 3.
    const parkThenKeepMine = (answered: boolean) => {
      let parked = false;
      const client: GoogleCalendarClientShape = {
        ...stubClient([
          answered
            ? {
                ...firstPage,
                items: [series, invitedOccurrence('Moved', '"x-1"', 'needsAction'), cancelled],
              }
            : firstPage,
          { items: [renamed], nextSyncToken: 's2' },
        ]),
        deleteEvent: ({ calendarId, eventId }) => {
          if (eventId === july3 && !parked) {
            parked = true;
            return Effect.fail(new ConflictError({ calendarId, eventId }));
          }
          return Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
        },
        getEvent: () => Effect.succeed(movedOccurrence('Moved again', '"x-2"')),
        patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      const setUp = Effect.gen(function* () {
        yield* seedAccount;
        const engine = yield* SyncEngine;
        yield* engine.syncAll();
        const mutations = yield* EventMutations;
        if (answered) {
          yield* mutations.respondToEvent({
            accountId: 'acc-1',
            calendarId: 'cal-1',
            eventId: july3,
            response: 'accepted',
          });
        }
        yield* cutThenDelete;
        yield* engine.syncAll();
        yield* mutations.resolveConflict({
          choice: 'mine',
          opId: (yield* opOf(july3, 'delete'))!.id,
        });
      });
      return { client, setUp };
    };

    describe('after a cut', () => {
      /** The series as the first pass stored it. */
      const firstSeries = [
        '07-02T10:00 Event evt-r',
        '07-03T12:00 Moved',
        '07-05T10:00 Event evt-r',
        '07-06T10:00 Event evt-r',
      ];

      it.effect(
        'discarding the cut’s delete of an exception puts it into the series delete',
        () => {
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* cutThenDelete;
            const mutations = yield* EventMutations;
            yield* mutations.discardPendingOp((yield* opOf(july3, 'delete'))!.id);
            yield* mutations.discardPendingOp(
              (yield* opOf('evt-r_20260704T100000Z', 'delete'))!.id,
            );
            // Written back as rows, July 3 showed without its series.
            expect(yield* shown).toEqual([]);
            expect(yield* (yield* EventRepo).listOverrides('acc-1', 'cal-1', 'evt-r')).toEqual([]);

            yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
            expect(yield* shown).toEqual(firstSeries);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        },
      );

      it.effect('keep-theirs on the cut’s parked delete puts Google’s copy there too', () => {
        let parked = false;
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage]),
          deleteEvent: ({ calendarId, eventId }) => {
            if (eventId === july3 && !parked) {
              parked = true;
              return Effect.fail(new ConflictError({ calendarId, eventId }));
            }
            return Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
          },
          getEvent: () => Effect.succeed(movedOccurrence('Moved again', '"x-2"')),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          yield* engine.syncAll();
          yield* cutThenDelete;
          yield* engine.syncAll();
          const own = yield* opOf(july3, 'delete');
          expect(own?.conflictAt).toBeDefined();

          const mutations = yield* EventMutations;
          yield* mutations.resolveConflict({ choice: 'theirs', opId: own!.id });
          // Written as a row, Google's July 3 showed without its series.
          expect(yield* shown).toEqual([]);
          yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
          expect(yield* shown).toContain('07-03T12:00 Moved again');
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('a pull that puts the master back brings back what the cut’s deletes took', () => {
        let online = false;
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage, { items: [renamed], nextSyncToken: 's2' }]),
          deleteEvent: () =>
            online ? Effect.void : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          yield* engine.syncAll();
          yield* cutThenDelete;
          yield* engine.syncAll();
          // July 3 showed at its slot, and the cancelled July 4 came back.
          expect(yield* shown).toEqual(googleSeries);
          expect(yield* strays).toEqual([]);

          online = true;
          const mutations = yield* EventMutations;
          yield* mutations.retryPendingOps();
          yield* mutations.processPendingOps();
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
          expect(yield* shown).toEqual([]);
          expect(yield* (yield* EventRepo).listOverrides('acc-1', 'cal-1', 'evt-r')).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('so does a discard of the series delete', () => {
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          yield* (yield* SyncEngine).syncAll();
          yield* cutThenDelete;
          const mutations = yield* EventMutations;
          yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
          // July 3 showed at its slot, and the cancelled July 4 came back.
          expect(yield* shown).toEqual(firstSeries);
          // Google's copy: the cut's delete went with the series delete.
          expect((yield* (yield* EventRepo).getById('acc-1', 'cal-1', july3))?.syncStatus).toBe(
            'synced',
          );
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('a cut’s delete that lands under the series back leaves Google’s tombstone', () => {
        // A pull puts the master back while the series delete waits, then
        // the cut's July 3 delete lands: removed, its copy left the slot
        // showing until a pull.
        let july3Online = false;
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage, { items: [renamed], nextSyncToken: 's2' }]),
          deleteEvent: ({ eventId }) =>
            july3Online && eventId === july3
              ? Effect.void
              : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          yield* engine.syncAll();
          yield* cutThenDelete;
          yield* engine.syncAll();
          expect(yield* shown).toEqual(googleSeries);
          july3Online = true;
          const mutations = yield* EventMutations;
          yield* mutations.retryPendingOps();
          yield* mutations.processPendingOps();
          expect(yield* opOf(july3, 'delete')).toBeUndefined();
          expect(yield* shown).toEqual([
            '07-02T10:00 Daily (Google)',
            '07-05T10:00 Daily (Google)',
            '07-06T10:00 Daily (Google)',
          ]);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('a discarded cut shows them as on Google, and an edit starts from one', () => {
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          yield* (yield* SyncEngine).syncAll();
          const mutations = yield* EventMutations;
          const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
          yield* mutations.deleteRecurring({
            ...at,
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'following',
          });
          yield* mutations.discardPendingOp((yield* opOf('evt-r', 'update'))!.id);
          // July 3 showed at its slot, and the cancelled July 4 came back.
          expect(yield* shown).toEqual(firstSeries);

          yield* mutations.updateRecurring({
            ...at,
            changes: { title: 'Edited' },
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'instance',
          });
          const edit = yield* opOf(july3, 'update');
          // Built on the slot, the edit moved July 3 back to 10:00 on Google.
          expect(edit?.payload?.startUtc).toBe(Date.parse('2026-07-03T12:00:00Z'));
          expect(edit?.beforePayload?.title).toBe('Moved');
          // It replaces the cut's delete of July 3, as an edit of a pulled copy does.
          expect(yield* opOf(july3, 'delete')).toBeUndefined();
          expect(yield* shown).toContain('07-03T12:00 Edited');
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('one an answer waits on comes back with that answer', () => {
        const client: GoogleCalendarClientShape = {
          ...stubClient([
            {
              ...firstPage,
              items: [series, invitedOccurrence('Moved', '"x-1"', 'needsAction'), cancelled],
            },
          ]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          yield* (yield* SyncEngine).syncAll();
          const mutations = yield* EventMutations;
          yield* mutations.respondToEvent({
            accountId: 'acc-1',
            calendarId: 'cal-1',
            eventId: july3,
            response: 'accepted',
          });
          yield* mutations.deleteRecurring({
            accountId: 'acc-1',
            calendarId: 'cal-1',
            masterId: 'evt-r',
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'following',
          });
          yield* mutations.discardPendingOp((yield* opOf('evt-r', 'update'))!.id);
          const answer = Effect.map(
            (yield* EventRepo).getById('acc-1', 'cal-1', july3),
            (row) => row?.attendees?.find((guest) => guest.isSelf)?.responseStatus,
          );
          // The cut's delete went with it, and the answer owns the row again:
          // left as Google's copy, it showed Google's answer until it landed.
          expect(yield* answer).toBe('accepted');
          expect((yield* (yield* PendingOpRepo).listAll()).map((op) => op.kind)).toEqual(['rsvp']);
          expect(yield* strays).toEqual([]);
          yield* mutations.discardPendingOp((yield* opOf(july3, 'rsvp'))!.id);
          expect(yield* answer).toBe('needsAction');
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('keep-theirs on the cut’s parked update shows them as on Google too', () => {
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          getEvent: () => Effect.succeed(renamed),
          patchEvent: ({ calendarId, eventId }) =>
            Effect.fail(new ConflictError({ calendarId, eventId })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          yield* (yield* SyncEngine).syncAll();
          const mutations = yield* EventMutations;
          yield* mutations.deleteRecurring({
            accountId: 'acc-1',
            calendarId: 'cal-1',
            masterId: 'evt-r',
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'following',
          });
          yield* mutations.processPendingOps();
          const truncation = yield* opOf('evt-r', 'update');
          expect(truncation?.conflictAt).toBeDefined();

          yield* mutations.resolveConflict({ choice: 'theirs', opId: truncation!.id });
          // July 3 showed at its slot, and the cancelled July 4 came back.
          expect(yield* shown).toEqual(googleSeries);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('a series Google deleted takes the copies the cut’s deletes hold along', () => {
        const client: GoogleCalendarClientShape = {
          ...stubClient([
            firstPage,
            { items: [{ id: 'evt-r', status: 'cancelled' }], nextSyncToken: 's2' },
          ]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          const mutations = yield* EventMutations;
          yield* engine.syncAll();
          yield* mutations.deleteRecurring({
            accountId: 'acc-1',
            calendarId: 'cal-1',
            masterId: 'evt-r',
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'following',
          });
          yield* engine.syncAll();
          yield* mutations.discardPendingOp((yield* opOf(july3, 'delete'))!.id);
          // Written back, July 3 showed without its series for good.
          expect(yield* shown).toEqual([]);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('keep-theirs on the cut’s update keeps them away past Google’s end', () => {
        // Ended on July 2 from another device meanwhile.
        const ended = { ...renamed, recurrence: ['RRULE:FREQ=DAILY;COUNT=1'] };
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          getEvent: () => Effect.succeed(ended),
          patchEvent: ({ calendarId, eventId }) =>
            Effect.fail(new ConflictError({ calendarId, eventId })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          yield* (yield* SyncEngine).syncAll();
          const mutations = yield* EventMutations;
          yield* mutations.deleteRecurring({
            accountId: 'acc-1',
            calendarId: 'cal-1',
            masterId: 'evt-r',
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'following',
          });
          yield* mutations.processPendingOps();
          yield* mutations.resolveConflict({
            choice: 'theirs',
            opId: (yield* opOf('evt-r', 'update'))!.id,
          });
          // Past the end of Google's rule, July 3 showed on its own.
          expect(yield* shown).toEqual(['07-02T10:00 Daily (Google)']);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('one that reached Google keeps them away, also from a longer series', () => {
        // Google ends the series on July 2; the cut's deletes still wait.
        // Another device then makes it twelve days, drawing their slots again.
        const truncated = {
          ...series,
          etag: '"evt-r-t"',
          recurrence: ['RRULE:FREQ=DAILY;COUNT=1'],
        };
        const longer = {
          ...renamed,
          etag: '"evt-r-t2"',
          recurrence: ['RRULE:FREQ=DAILY;COUNT=12'],
        };
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage, { items: [longer], nextSyncToken: 's2' }]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          patchEvent: () => Effect.succeed(truncated),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          const mutations = yield* EventMutations;
          yield* engine.syncAll();
          const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
          yield* mutations.deleteRecurring({
            ...at,
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'following',
          });
          yield* mutations.processPendingOps();
          expect(yield* opOf('evt-r', 'update')).toBeUndefined();
          yield* mutations.deleteRecurring({
            ...at,
            originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
            scope: 'series',
          });
          yield* engine.syncAll();
          // The moved July 3 came back over the longer series.
          expect(yield* shown).toEqual([
            '07-02T10:00 Daily (Google)',
            '07-03T10:00 Daily (Google)',
            '07-04T10:00 Daily (Google)',
            '07-05T10:00 Daily (Google)',
            '07-06T10:00 Daily (Google)',
            '07-07T10:00 Daily (Google)',
          ]);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      const drain = Effect.gen(function* () {
        const mutations = yield* EventMutations;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
      });

      describe('abandoned, it takes the deletes it queued along', () => {
        // Left queued, they deleted July 3 and July 4 on Google although
        // the cut was undone.
        const cutJuly3 = Effect.gen(function* () {
          yield* (yield* EventMutations).deleteRecurring({
            accountId: 'acc-1',
            calendarId: 'cal-1',
            masterId: 'evt-r',
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'following',
          });
        });

        it.effect('a discard', () => {
          let online = false;
          const google = deleting(() => online);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: google.deleteEvent,
            patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* cutJuly3;
            yield* (yield* EventMutations).discardPendingOp((yield* opOf('evt-r', 'update'))!.id);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            online = true;
            yield* drain;
            expect(google.deleted).toEqual([]);
            expect(yield* shown).toEqual(firstSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('keep-theirs on its parked update', () => {
          let online = false;
          const google = deleting(() => online);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: google.deleteEvent,
            getEvent: () => Effect.succeed(renamed),
            patchEvent: ({ calendarId, eventId }) =>
              Effect.fail(new ConflictError({ calendarId, eventId })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* cutJuly3;
            const mutations = yield* EventMutations;
            yield* mutations.processPendingOps();
            yield* mutations.resolveConflict({
              choice: 'theirs',
              opId: (yield* opOf('evt-r', 'update'))!.id,
            });
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            online = true;
            yield* drain;
            expect(google.deleted).toEqual([]);
            expect(yield* shown).toEqual(googleSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('a rejection for good', () => {
          let online = false;
          const google = deleting(() => online);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: google.deleteEvent,
            patchEvent: () =>
              online
                ? Effect.fail(
                    new GoogleApiError({ message: 'forbiddenForNonOrganizer', status: 403 }),
                  )
                : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* cutJuly3;
            online = true;
            yield* drain;
            yield* drain;
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(google.deleted).toEqual([]);
            expect(yield* shown).toEqual(firstSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('a discard of the series delete that replaced it', () => {
          let online = false;
          const google = deleting(() => online);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: google.deleteEvent,
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* cutThenDelete;
            // The series comes back as Google has it, uncut.
            yield* (yield* EventMutations).discardPendingOp((yield* seriesDelete)!.id);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            online = true;
            yield* drain;
            expect(google.deleted).toEqual([]);
            expect(yield* shown).toEqual(firstSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('but not an occurrence delete you made before it', () => {
          let online = false;
          const google = deleting(() => online);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: google.deleteEvent,
            patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            const mutations = yield* EventMutations;
            const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
            // The moved July 3, and the plain July 5.
            yield* mutations.deleteRecurring({
              ...at,
              originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
              scope: 'instance',
            });
            yield* mutations.deleteRecurring({
              ...at,
              originalStartUtc: Date.parse('2026-07-05T10:00:00Z'),
              scope: 'instance',
            });
            yield* cutJuly3;
            yield* mutations.discardPendingOp((yield* opOf('evt-r', 'update'))!.id);
            // Folded into the cut's deletes, they went with it: July 3 and
            // July 5 came back.
            expect(yield* shown).toEqual(['07-02T10:00 Event evt-r', '07-06T10:00 Event evt-r']);
            expect(yield* strays).toEqual([]);
            online = true;
            yield* drain;
            expect(google.deleted.sort()).toEqual([july3, 'evt-r_20260705T100000Z']);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* shown).toEqual(['07-02T10:00 Event evt-r', '07-06T10:00 Event evt-r']);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });
      });

      describe('an edit of July 3 and following, abandoned, takes the new series along', () => {
        // Left queued (or sent already: it did not wait for the cut), the new
        // series went out, and Google showed July 3–6 twice: in the old
        // series, uncut, and in the new one.
        const yoga = [
          '07-03T10:00 Yoga',
          '07-04T10:00 Yoga',
          '07-05T10:00 Yoga',
          '07-06T10:00 Yoga',
        ];
        const editJuly3On = Effect.gen(function* () {
          yield* (yield* EventMutations).updateRecurring({
            accountId: 'acc-1',
            calendarId: 'cal-1',
            changes: { title: 'Yoga' },
            masterId: 'evt-r',
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'following',
          });
          expect(yield* shown).toEqual(['07-02T10:00 Event evt-r', ...yoga]);
        });
        const newSeries = Effect.gen(function* () {
          const ops = yield* (yield* PendingOpRepo).listAll();
          return ops.find((op) => op.kind === 'create');
        });
        /** Google's copy once the cut landed: the series ends on July 2. */
        const cutOnGoogle = {
          ...series,
          etag: '"evt-r-t"',
          recurrence: ['RRULE:FREQ=DAILY;UNTIL=20260703T095959Z'],
        };

        it.effect('a discard', () => {
          let online = false;
          const removal = deleting(() => online);
          const insertion = inserting(() => online);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: removal.deleteEvent,
            getEvent: () => (online ? Effect.succeed(series) : offline()),
            insertEvent: insertion.insertEvent,
            patchEvent: offline,
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            yield* (yield* EventMutations).discardPendingOp((yield* opOf('evt-r', 'update'))!.id);
            // Its days go now; it asks Google whether the cut is there
            // before it goes.
            expect(yield* shown).toEqual(firstSeries);
            expect((yield* newSeries)?.splitCheck).toBe('cal-1');
            online = true;
            yield* drain;
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(insertion.inserted).toEqual([]);
            expect(removal.deleted).toEqual([]);
            expect(yield* shown).toEqual(firstSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('keep-theirs on its parked update, which the new series waits for', () => {
          const removal = deleting(() => true);
          const insertion = inserting(() => true);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: removal.deleteEvent,
            getEvent: () => Effect.succeed(renamed),
            insertEvent: insertion.insertEvent,
            patchEvent: conflict,
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            const mutations = yield* EventMutations;
            yield* mutations.processPendingOps();
            const truncation = yield* opOf('evt-r', 'update');
            expect(truncation?.conflictAt).toBeDefined();
            // Sent while the cut waited for the user, it stayed on Google
            // whatever they chose.
            expect(insertion.inserted).toEqual([]);

            yield* mutations.resolveConflict({ choice: 'theirs', opId: truncation!.id });
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            yield* drain;
            expect(insertion.inserted).toEqual([]);
            expect(removal.deleted).toEqual([]);
            expect(yield* shown).toEqual(googleSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('a rejection for good', () => {
          let online = false;
          const removal = deleting(() => online);
          const insertion = inserting(() => online);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: removal.deleteEvent,
            getEvent: () => Effect.succeed(series),
            insertEvent: insertion.insertEvent,
            patchEvent: () =>
              online
                ? Effect.fail(
                    new GoogleApiError({ message: 'forbiddenForNonOrganizer', status: 403 }),
                  )
                : offline(),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            online = true;
            yield* drain;
            yield* drain;
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(insertion.inserted).toEqual([]);
            expect(removal.deleted).toEqual([]);
            expect(yield* shown).toEqual(firstSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('a discard of the series delete that replaced it', () => {
          let online = false;
          const removal = deleting(() => online);
          const insertion = inserting(() => online);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: removal.deleteEvent,
            getEvent: () => (online ? Effect.succeed(series) : offline()),
            insertEvent: insertion.insertEvent,
            patchEvent: offline,
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            const mutations = yield* EventMutations;
            yield* mutations.deleteRecurring({
              accountId: 'acc-1',
              calendarId: 'cal-1',
              masterId: 'evt-r',
              originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
              scope: 'series',
            });
            expect(yield* shown).toEqual(yoga);
            yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
            expect(yield* shown).toEqual(firstSeries);
            online = true;
            yield* drain;
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(insertion.inserted).toEqual([]);
            expect(removal.deleted).toEqual([]);
            expect(yield* shown).toEqual(firstSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('keep-theirs on a parked series delete that replaced it', () => {
          const insertion = inserting(() => true);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: (params) => (params.eventId === 'evt-r' ? conflict(params) : offline()),
            getEvent: () => Effect.succeed(renamed),
            insertEvent: insertion.insertEvent,
            patchEvent: offline,
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            const mutations = yield* EventMutations;
            yield* mutations.deleteRecurring({
              accountId: 'acc-1',
              calendarId: 'cal-1',
              masterId: 'evt-r',
              originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
              scope: 'series',
            });
            yield* mutations.processPendingOps();
            const remove = yield* seriesDelete;
            expect(remove?.conflictAt).toBeDefined();
            expect(insertion.inserted).toEqual([]);

            yield* mutations.resolveConflict({ choice: 'theirs', opId: remove!.id });
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            yield* drain;
            expect(insertion.inserted).toEqual([]);
            expect(yield* shown).toEqual(googleSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('with the edits made to it since, and a split of it', () => {
          let online = false;
          const insertion = inserting(() => online);
          const patched: Array<string> = [];
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: deleting(() => online).deleteEvent,
            getEvent: () => (online ? Effect.succeed(series) : offline()),
            insertEvent: insertion.insertEvent,
            patchEvent: ({ eventId }) => {
              if (online) {
                patched.push(eventId);
              }
              return offline();
            },
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            const mutations = yield* EventMutations;
            const created = (yield* newSeries)!;
            const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: created.eventId };
            yield* mutations.updateRecurring({
              ...at,
              changes: { title: 'Yoga 2' },
              originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
              scope: 'series',
            });
            yield* mutations.updateRecurring({
              ...at,
              changes: { title: 'Pilates' },
              originalStartUtc: Date.parse('2026-07-04T10:00:00Z'),
              scope: 'instance',
            });
            yield* mutations.updateRecurring({
              ...at,
              changes: { title: 'Run' },
              originalStartUtc: Date.parse('2026-07-05T10:00:00Z'),
              scope: 'following',
            });
            expect(yield* shown).toEqual([
              '07-02T10:00 Event evt-r',
              '07-03T10:00 Yoga 2',
              '07-04T10:00 Pilates',
              '07-05T10:00 Run',
              '07-06T10:00 Run',
            ]);

            yield* mutations.discardPendingOp((yield* opOf('evt-r', 'update'))!.id);
            expect(yield* shown).toEqual(firstSeries);
            expect(
              yield* (yield* EventRepo).listOverrides('acc-1', 'cal-1', created.eventId),
            ).toEqual([]);
            online = true;
            yield* drain;
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(insertion.inserted).toEqual([]);
            expect(patched).toEqual([]);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('but not one Google’s own end of the old series leaves alone', () => {
          // Ended on July 2 from another device meanwhile: nothing shows twice.
          const ended = { ...renamed, recurrence: ['RRULE:FREQ=DAILY;COUNT=1'] };
          const insertion = inserting(() => true);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: deleting(() => true).deleteEvent,
            getEvent: () => Effect.succeed(ended),
            insertEvent: insertion.insertEvent,
            patchEvent: conflict,
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            const created = (yield* newSeries)!;
            const mutations = yield* EventMutations;
            yield* mutations.processPendingOps();
            yield* mutations.resolveConflict({
              choice: 'theirs',
              opId: (yield* opOf('evt-r', 'update'))!.id,
            });
            yield* drain;
            expect(insertion.inserted).toEqual(['Yoga']);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* shown).toEqual(['07-02T10:00 Daily (Google)', ...yoga]);
            expect(yield* strays).toEqual([]);
            expect(yield* straysOf(created.eventId)).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('nor one whose cut reached Google, when a series delete is undone later', () => {
          // Google ends the old series on July 2; the new one's insert meets a
          // 503 first, and is still queued when the series delete is made.
          const truncated = {
            ...series,
            etag: '"evt-r-t"',
            recurrence: ['RRULE:FREQ=DAILY;UNTIL=20260703T095959Z'],
          };
          let inserts = 0;
          const insertion = inserting(() => inserts++ > 0);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: offline,
            getEvent: () => Effect.succeed(cutOnGoogle),
            insertEvent: insertion.insertEvent,
            patchEvent: () => Effect.succeed(truncated),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            const created = (yield* newSeries)!;
            const mutations = yield* EventMutations;
            yield* mutations.processPendingOps();
            expect(yield* opOf('evt-r', 'update')).toBeUndefined();
            yield* mutations.deleteRecurring({
              accountId: 'acc-1',
              calendarId: 'cal-1',
              masterId: 'evt-r',
              originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
              scope: 'series',
            });
            yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
            yield* drain;
            expect(insertion.inserted).toEqual(['Yoga']);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* shown).toEqual(['07-02T10:00 Event evt-r', ...yoga]);
            expect(yield* strays).toEqual([]);
            expect(yield* straysOf(created.eventId)).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect(
          'it goes out once the cut landed, also when the cut waits out a 503 first',
          () => {
            // Ahead of the cut, it showed July 3–6 twice on Google until the
            // cut landed, and for good if the cut never did.
            const landed: Array<string | undefined> = [];
            let patches = 0;
            const client: GoogleCalendarClientShape = {
              ...stubClient([firstPage]),
              deleteEvent: offline,
              getEvent: () => Effect.succeed(cutOnGoogle),
              insertEvent: ({ event }) => {
                landed.push(event.summary);
                return Effect.succeed(insertedCopy(event));
              },
              patchEvent: ({ eventId }) => {
                if (patches++ === 0) {
                  return offline();
                }
                landed.push(eventId);
                return Effect.succeed({
                  ...series,
                  etag: '"evt-r-t"',
                  recurrence: ['RRULE:FREQ=DAILY;UNTIL=20260703T095959Z'],
                });
              },
            };
            return Effect.gen(function* () {
              yield* seedAccount;
              yield* (yield* SyncEngine).syncAll();
              yield* editJuly3On;
              yield* (yield* EventMutations).processPendingOps();
              expect(landed).toEqual([]);
              yield* drain;
              expect(landed).toEqual(['evt-r', 'Yoga']);
              expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
              expect(yield* shown).toEqual(['07-02T10:00 Event evt-r', ...yoga]);
              expect(yield* strays).toEqual([]);
            }).pipe(Effect.provide(engineLayer(client)));
          },
        );

        it.effect('a discard while the cut is on its way leaves it, as Google has the cut', () => {
          // Back as asked, it went with the cut, which Google made anyway:
          // nothing showed from July 3 on, here or there.
          let whileSent: Effect.Effect<void> = Effect.void;
          const insertion = inserting(() => true);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: offline,
            getEvent: () => Effect.succeed(cutOnGoogle),
            insertEvent: insertion.insertEvent,
            patchEvent: () => Effect.andThen(whileSent, Effect.succeed(cutOnGoogle)),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            const mutations = yield* EventMutations;
            const cut = (yield* opOf('evt-r', 'update'))!;
            let discarding: Fiber.Fiber<void, unknown> | undefined;
            whileSent = Effect.gen(function* () {
              discarding = yield* Effect.forkDetach(mutations.discardPendingOp(cut.id));
              for (let turn = 0; turn < 50; turn += 1) {
                yield* Effect.yieldNow;
              }
            });
            yield* mutations.processPendingOps();
            yield* Fiber.join(discarding!);
            yield* drain;
            expect(insertion.inserted).toEqual(['Yoga']);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* shown).toEqual(['07-02T10:00 Event evt-r', ...yoga]);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('nor a discard of a cut that landed with its answer lost', () => {
          let landed = false;
          const insertion = inserting(() => true);
          // What the next pull brings once Google made the cut: the series
          // ends on July 2, and the moved July 3 went with it.
          const cutPage = {
            items: [
              cutOnGoogle,
              {
                id: july3,
                originalStartTime: { dateTime: '2026-07-03T10:00:00Z' },
                recurringEventId: 'evt-r',
                status: 'cancelled',
              },
            ],
            nextSyncToken: 's2',
          };
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage, cutPage]),
            deleteEvent: offline,
            getEvent: () => Effect.succeed(landed ? cutOnGoogle : series),
            insertEvent: insertion.insertEvent,
            // Google makes the cut; its answer never arrives.
            patchEvent: () => {
              landed = true;
              return offline();
            },
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            const created = (yield* newSeries)!;
            const mutations = yield* EventMutations;
            yield* mutations.processPendingOps();
            expect(insertion.inserted).toEqual([]);

            yield* mutations.discardPendingOp((yield* opOf('evt-r', 'update'))!.id);
            yield* drain;
            expect(insertion.inserted).toEqual(['Yoga']);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            // The series shows as the discard left it until a pull says what
            // Google has.
            yield* (yield* SyncEngine).syncAll();
            expect(yield* shown).toEqual(['07-02T10:00 Event evt-r', ...yoga]);
            expect(yield* strays).toEqual([]);
            expect(yield* straysOf(created.eventId)).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('the series split off it goes too, also once it is deleted itself', () => {
          // Split off the new series, it waited for that one's create:
          // deleted unsent, the create left, and July 5–6 went out while the
          // cut waited for the user, then showed twice.
          const insertion = inserting(() => true);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: offline,
            getEvent: () => Effect.succeed(renamed),
            insertEvent: insertion.insertEvent,
            patchEvent: conflict,
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            const created = (yield* newSeries)!;
            const mutations = yield* EventMutations;
            const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: created.eventId };
            yield* mutations.updateRecurring({
              ...at,
              changes: { title: 'Run' },
              originalStartUtc: Date.parse('2026-07-05T10:00:00Z'),
              scope: 'following',
            });
            yield* mutations.deleteRecurring({
              ...at,
              originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
              scope: 'series',
            });
            expect(yield* shown).toEqual([
              '07-02T10:00 Event evt-r',
              '07-05T10:00 Run',
              '07-06T10:00 Run',
            ]);
            yield* mutations.processPendingOps();
            expect(insertion.inserted).toEqual([]);

            yield* mutations.resolveConflict({
              choice: 'theirs',
              opId: (yield* opOf('evt-r', 'update'))!.id,
            });
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            yield* drain;
            expect(insertion.inserted).toEqual([]);
            expect(yield* shown).toEqual(googleSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect(
          'keep-mine on the cut lets it out at the next pass, not after its backoff',
          () => {
            // It waited out a backoff that grew while the cut waited for the
            // user: up to half an hour of the series ending on July 2 on Google.
            let landed = false;
            const insertion = inserting(() => true);
            const client: GoogleCalendarClientShape = {
              ...stubClient([firstPage]),
              deleteEvent: offline,
              getEvent: () => Effect.succeed(landed ? cutOnGoogle : renamed),
              insertEvent: insertion.insertEvent,
              // Keep-mine sends it without If-Match.
              patchEvent: (params) => {
                if (params.baseEtag !== undefined) {
                  return conflict(params);
                }
                landed = true;
                return Effect.succeed(cutOnGoogle);
              },
            };
            return Effect.gen(function* () {
              yield* seedAccount;
              yield* (yield* SyncEngine).syncAll();
              yield* editJuly3On;
              const mutations = yield* EventMutations;
              yield* drain;
              yield* drain;
              yield* drain;
              expect((yield* newSeries)?.attempts).toBeGreaterThan(1);

              yield* mutations.resolveConflict({
                choice: 'mine',
                opId: (yield* opOf('evt-r', 'update'))!.id,
              });
              yield* mutations.processPendingOps();
              yield* mutations.processPendingOps();
              expect(insertion.inserted).toEqual(['Yoga']);
              expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
              expect(yield* shown).toEqual(['07-02T10:00 Event evt-r', ...yoga]);
            }).pipe(Effect.provide(engineLayer(client)));
          },
        );

        it.effect('a discard while a pass holds the queue keeps the cut from Google', () => {
          // Left queued while the discard waited for the queue, the cut went
          // out with a drain that was waiting first, and the discard came to
          // nothing.
          const patched: Array<string> = [];
          const insertion = inserting(() => true);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: offline,
            getEvent: () => Effect.succeed(series),
            insertEvent: insertion.insertEvent,
            patchEvent: ({ eventId }) => {
              patched.push(eventId);
              return Effect.succeed(cutOnGoogle);
            },
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            const mutations = yield* EventMutations;
            const holding = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const pass = yield* Effect.forkChild(
              mutations.whileQueueHeld(
                Effect.andThen(Deferred.succeed(holding, undefined), Deferred.await(release)),
              ),
            );
            yield* Deferred.await(holding);
            yield* editJuly3On;
            const waiting = yield* Effect.forkChild(mutations.processPendingOps());
            const discarding = yield* Effect.forkChild(
              mutations.discardPendingOp((yield* opOf('evt-r', 'update'))!.id),
            );
            for (let turn = 0; turn < 50; turn += 1) {
              yield* Effect.yieldNow;
            }
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(pass);
            yield* Fiber.join(waiting);
            yield* Fiber.join(discarding);
            yield* drain;
            expect(patched).toEqual([]);
            expect(insertion.inserted).toEqual([]);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* shown).toEqual(firstSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('the series split off it goes by where the first split started', () => {
          // Re-timed to 14:00, a split of it from July 5 asked whether the
          // old series draws from July 5 at 14:00: Google's, ended on July 5
          // at 10:00 meanwhile, did not, and both showed on July 5.
          const endedJuly5 = { ...renamed, recurrence: ['RRULE:FREQ=DAILY;COUNT=4'] };
          const insertion = inserting(() => true);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: offline,
            getEvent: () => Effect.succeed(endedJuly5),
            insertEvent: insertion.insertEvent,
            patchEvent: conflict,
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            const mutations = yield* EventMutations;
            yield* mutations.updateRecurring({
              accountId: 'acc-1',
              calendarId: 'cal-1',
              changes: {
                endUtc: Date.parse('2026-07-03T15:00:00Z'),
                startUtc: Date.parse('2026-07-03T14:00:00Z'),
                title: 'Yoga',
              },
              masterId: 'evt-r',
              originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
              scope: 'following',
            });
            yield* mutations.updateRecurring({
              accountId: 'acc-1',
              calendarId: 'cal-1',
              changes: { title: 'Run' },
              masterId: (yield* newSeries)!.eventId,
              originalStartUtc: Date.parse('2026-07-05T14:00:00Z'),
              scope: 'following',
            });
            expect(yield* shown).toEqual([
              '07-02T10:00 Event evt-r',
              '07-03T14:00 Yoga',
              '07-04T14:00 Yoga',
              '07-05T14:00 Run',
              '07-06T14:00 Run',
            ]);
            yield* mutations.processPendingOps();
            yield* mutations.resolveConflict({
              choice: 'theirs',
              opId: (yield* opOf('evt-r', 'update'))!.id,
            });
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            yield* drain;
            expect(insertion.inserted).toEqual([]);
            expect(yield* shown).toEqual([
              '07-02T10:00 Daily (Google)',
              '07-03T12:00 Moved',
              '07-05T10:00 Daily (Google)',
            ]);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('once sent, it waits for no later change of the old series', () => {
          // It may be on Google already: held behind a series delete that
          // waited for the user, its retry waited with it, its row pending.
          let inserts = 0;
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: conflict,
            getEvent: () => Effect.succeed(cutOnGoogle),
            insertEvent: ({ event }) => {
              inserts += 1;
              return inserts === 1 ? offline() : Effect.succeed(insertedCopy(event));
            },
            patchEvent: () => Effect.succeed(cutOnGoogle),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* editJuly3On;
            const mutations = yield* EventMutations;
            yield* mutations.processPendingOps();
            expect((yield* newSeries)?.dispatchedAt).toBeDefined();
            yield* mutations.deleteRecurring({
              accountId: 'acc-1',
              calendarId: 'cal-1',
              masterId: 'evt-r',
              originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
              scope: 'series',
            });
            yield* drain;
            expect((yield* seriesDelete)?.conflictAt).toBeDefined();
            expect(inserts).toBe(2);
            expect(yield* newSeries).toBeUndefined();
          }).pipe(Effect.provide(engineLayer(client)));
        });
      });

      it.effect(
        'an occurrence delete made before it waits for it, and is done once it lands',
        () => {
          // Google changed July 3, so July 3's own delete meets a 412. Left
          // ahead of the cut, it went out first and parked; keep-theirs then
          // showed July 3 past the series' new end until the cut landed. Google
          // cancels July 3 with the truncation.
          let july3Deletes = 0;
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: ({ calendarId, eventId }) => {
              if (eventId !== july3) {
                return Effect.void;
              }
              july3Deletes += 1;
              return Effect.fail(new ConflictError({ calendarId, eventId }));
            },
            getEvent: () => Effect.succeed(movedOccurrence('Moved again', '"x-2"')),
            patchEvent: () =>
              Effect.succeed({
                ...series,
                etag: '"evt-r-t"',
                recurrence: ['RRULE:FREQ=DAILY;COUNT=1'],
              }),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            const mutations = yield* EventMutations;
            const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
            yield* mutations.deleteRecurring({
              ...at,
              originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
              scope: 'instance',
            });
            yield* mutations.deleteRecurring({
              ...at,
              originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
              scope: 'following',
            });
            yield* mutations.processPendingOps();
            yield* mutations.processPendingOps();
            expect(july3Deletes).toBe(0);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* shown).toEqual(['07-02T10:00 Event evt-r']);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        },
      );

      describe('keep-mine on the cut’s delete under the series back, then', () => {
        it.effect('a new rule that draws July 3 again takes the delete back', () => {
          // The tombstone made the delete look like one the user made: it
          // stayed, and cancelled July 3, which Google keeps under the rule.
          const { client, setUp } = parkThenKeepMine(false);
          return Effect.gen(function* () {
            yield* setUp;
            yield* (yield* EventMutations).updateRecurring({
              accountId: 'acc-1',
              calendarId: 'cal-1',
              changes: { recurrence: ['RRULE:FREQ=DAILY;COUNT=12'] },
              masterId: 'evt-r',
              originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
              scope: 'series',
            });
            expect(yield* opOf(july3, 'delete')).toBeUndefined();
            expect(yield* shown).toContain('07-03T12:00 Moved');
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('a discarded series delete shows July 3 with the answer still queued', () => {
          // Kept hidden by the tombstone the answer also owned; discarding
          // the answer then left a cancelled row Google never had.
          const { client, setUp } = parkThenKeepMine(true);
          return Effect.gen(function* () {
            yield* setUp;
            const mutations = yield* EventMutations;
            yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
            const row = Effect.map((yield* EventRepo).getById('acc-1', 'cal-1', july3), (copy) => [
              copy?.status,
              copy?.attendees?.find((guest) => guest.isSelf)?.responseStatus,
            ]);
            expect(yield* row).toEqual(['confirmed', 'accepted']);
            expect(yield* strays).toEqual([]);
            yield* mutations.discardPendingOp((yield* opOf(july3, 'rsvp'))!.id);
            expect(yield* row).toEqual(['confirmed', 'needsAction']);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });
      });

      it.effect(
        'keep-mine on the cut’s delete keeps it, too, from a discarded series delete',
        () => {
          // A pull puts the master back while the series delete waits, July
          // 3's delete meets a 412 and the user keeps theirs. Its tombstone
          // made the delete look like one the user made: the series delete's
          // discard left it, and it cancelled July 3 on Google. Without the
          // pull, the same steps took it along.
          let online = false;
          let parked = false;
          const deleted: Array<string> = [];
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage, { items: [renamed], nextSyncToken: 's2' }]),
            deleteEvent: ({ calendarId, eventId }) => {
              if (eventId === july3 && !parked) {
                parked = true;
                return Effect.fail(new ConflictError({ calendarId, eventId }));
              }
              if (!online) {
                return Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
              }
              deleted.push(eventId);
              return Effect.void;
            },
            getEvent: () => Effect.succeed(movedOccurrence('Moved again', '"x-2"')),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            const engine = yield* SyncEngine;
            yield* engine.syncAll();
            yield* cutThenDelete;
            yield* engine.syncAll();
            const mutations = yield* EventMutations;
            yield* mutations.resolveConflict({
              choice: 'mine',
              opId: (yield* opOf(july3, 'delete'))!.id,
            });
            yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* shown).toEqual(googleSeries);
            expect(yield* strays).toEqual([]);
            online = true;
            yield* mutations.retryPendingOps();
            yield* mutations.processPendingOps();
            expect(deleted).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        },
      );

      describe('a later series change that replaces it, queued behind its deletes,', () => {
        // The replacement goes to the back of the queue: the cut's deletes
        // and the user's own went out ahead of it, past taking back.
        const july3At = Date.parse('2026-07-03T10:00:00Z');
        const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
        const rename = Effect.gen(function* () {
          yield* (yield* EventMutations).updateRecurring({
            ...at,
            changes: { title: 'Renamed' },
            originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
            scope: 'series',
          });
        });
        const drain = Effect.gen(function* () {
          const mutations = yield* EventMutations;
          yield* mutations.retryPendingOps();
          yield* mutations.processPendingOps();
        });

        it.effect('a rename: keep-theirs on it takes the deletes along unsent', () => {
          let online = false;
          const google = deleting(() => online);
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: google.deleteEvent,
            getEvent: () => Effect.succeed(renamed),
            patchEvent: ({ calendarId, eventId }) =>
              online
                ? Effect.fail(new ConflictError({ calendarId, eventId }))
                : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* (yield* EventMutations).deleteRecurring({
              ...at,
              originalStartUtc: july3At,
              scope: 'following',
            });
            yield* rename;
            online = true;
            yield* drain;
            expect(google.deleted).toEqual([]);
            yield* (yield* EventMutations).resolveConflict({
              choice: 'theirs',
              opId: (yield* opOf('evt-r', 'update'))!.id,
            });
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* shown).toEqual(googleSeries);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('the user’s own delete still waits for it, and is done once it lands', () => {
          // Google changed July 3: sent ahead of the rename, its delete met
          // a 412.
          let july3Deletes = 0;
          let online = false;
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: ({ calendarId, eventId }) => {
              if (!online) {
                return Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
              }
              july3Deletes += eventId === july3 ? 1 : 0;
              return eventId === july3
                ? Effect.fail(new ConflictError({ calendarId, eventId }))
                : Effect.void;
            },
            getEvent: () => Effect.succeed(movedOccurrence('Moved again', '"x-2"')),
            patchEvent: () =>
              online
                ? Effect.succeed({
                    ...series,
                    etag: '"evt-r-t"',
                    recurrence: ['RRULE:FREQ=DAILY;COUNT=1'],
                    summary: 'Renamed',
                  })
                : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            const mutations = yield* EventMutations;
            yield* mutations.deleteRecurring({
              ...at,
              originalStartUtc: july3At,
              scope: 'instance',
            });
            yield* mutations.deleteRecurring({
              ...at,
              originalStartUtc: july3At,
              scope: 'following',
            });
            yield* rename;
            online = true;
            yield* drain;
            yield* drain;
            expect(july3Deletes).toBe(0);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* shown).toEqual(['07-02T10:00 Renamed']);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });
      });

      it.effect('the user’s parked delete it queues behind itself waits unparked', () => {
        // Still parked, keep-theirs on it showed July 3 past the cut until
        // the cut landed; Google cancels July 3 with the cut.
        let online = true;
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage]),
          deleteEvent: ({ calendarId, eventId }) =>
            online
              ? Effect.fail(new ConflictError({ calendarId, eventId }))
              : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          getEvent: () => Effect.succeed(movedOccurrence('Moved again', '"x-2"')),
          patchEvent: () =>
            online
              ? Effect.succeed({
                  ...series,
                  etag: '"evt-r-t"',
                  recurrence: ['RRULE:FREQ=DAILY;COUNT=1'],
                })
              : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          yield* (yield* SyncEngine).syncAll();
          const mutations = yield* EventMutations;
          const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
          const july3At = Date.parse('2026-07-03T10:00:00Z');
          yield* mutations.deleteRecurring({ ...at, originalStartUtc: july3At, scope: 'instance' });
          yield* mutations.processPendingOps();
          expect((yield* opOf(july3, 'delete'))?.conflictAt).toBeDefined();
          online = false;
          yield* mutations.deleteRecurring({
            ...at,
            originalStartUtc: july3At,
            scope: 'following',
          });
          expect((yield* opOf(july3, 'delete'))?.conflictAt).toBeUndefined();
          online = true;
          yield* mutations.retryPendingOps();
          yield* mutations.processPendingOps();
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
          expect(yield* shown).toEqual(['07-02T10:00 Event evt-r']);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('keep-mine on the cut’s parked delete keeps July 3 away from the series', () => {
        // A pull puts the master back while the series delete waits; Google
        // changed July 3, so its delete meets a 412.
        let online = false;
        let parked = false;
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage, { items: [renamed], nextSyncToken: 's2' }]),
          deleteEvent: ({ calendarId, eventId }) => {
            if (eventId === july3 && !parked) {
              parked = true;
              return Effect.fail(new ConflictError({ calendarId, eventId }));
            }
            return online
              ? Effect.void
              : Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
          },
          getEvent: () => Effect.succeed(movedOccurrence('Moved again', '"x-2"')),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          yield* engine.syncAll();
          yield* cutThenDelete;
          yield* engine.syncAll();
          expect(yield* shown).toEqual(googleSeries);
          const own = yield* opOf(july3, 'delete');
          expect(own?.conflictAt).toBeDefined();

          const mutations = yield* EventMutations;
          yield* mutations.resolveConflict({ choice: 'mine', opId: own!.id });
          // Its copy taken off the table, July 3 showed at its slot.
          expect(yield* shown).toEqual([
            '07-02T10:00 Daily (Google)',
            '07-05T10:00 Daily (Google)',
            '07-06T10:00 Daily (Google)',
          ]);
          expect((yield* opOf(july3, 'delete'))?.beforePayload?.title).toBe('Moved');
          expect(yield* strays).toEqual([]);

          online = true;
          yield* mutations.retryPendingOps();
          yield* mutations.processPendingOps();
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
          expect(yield* shown).toEqual([]);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('and its discard shows July 3 as Google has it', () => {
        let parked = false;
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage, { items: [renamed], nextSyncToken: 's2' }]),
          deleteEvent: ({ calendarId, eventId }) => {
            if (eventId === july3 && !parked) {
              parked = true;
              return Effect.fail(new ConflictError({ calendarId, eventId }));
            }
            return Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
          },
          getEvent: () => Effect.succeed(movedOccurrence('Moved again', '"x-2"')),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          yield* engine.syncAll();
          yield* cutThenDelete;
          yield* engine.syncAll();
          const mutations = yield* EventMutations;
          yield* mutations.resolveConflict({
            choice: 'mine',
            opId: (yield* opOf(july3, 'delete'))!.id,
          });
          yield* mutations.discardPendingOp((yield* opOf(july3, 'delete'))!.id);
          expect(yield* shown).toEqual(googleSeries);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      describe('a pull that sends a changed exception past it while it waits', () => {
        const movedAgain = {
          items: [movedOccurrence('Moved again', '"x-2"')],
          nextSyncToken: 's2',
        };
        const cutJuly3 = Effect.gen(function* () {
          yield* (yield* EventMutations).deleteRecurring({
            accountId: 'acc-1',
            calendarId: 'cal-1',
            masterId: 'evt-r',
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'following',
          });
        });

        it.effect('keeps it in that exception’s delete, which takes it when the cut lands', () => {
          let online = false;
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage, movedAgain]),
            deleteEvent: () =>
              online ? Effect.void : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
            patchEvent: () =>
              online
                ? Effect.succeed({
                    ...series,
                    etag: '"evt-r-t"',
                    recurrence: ['RRULE:FREQ=DAILY;COUNT=1'],
                  })
                : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            const engine = yield* SyncEngine;
            yield* engine.syncAll();
            yield* cutJuly3;
            yield* engine.syncAll();
            // Written as a row, July 3 showed past the series' new end on its own.
            expect(yield* shown).toEqual(['07-02T10:00 Event evt-r']);
            expect((yield* opOf(july3, 'delete'))?.beforePayload?.title).toBe('Moved again');
            expect(yield* strays).toEqual([]);

            online = true;
            const mutations = yield* EventMutations;
            yield* mutations.retryPendingOps();
            yield* mutations.processPendingOps();
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* shown).toEqual(['07-02T10:00 Event evt-r']);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });

        it.effect('and a discarded cut shows it as Google has it now', () => {
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage, movedAgain]),
            deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
            patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            const engine = yield* SyncEngine;
            yield* engine.syncAll();
            yield* cutJuly3;
            yield* engine.syncAll();
            const mutations = yield* EventMutations;
            yield* mutations.discardPendingOp((yield* opOf('evt-r', 'update'))!.id);
            expect(yield* shown).toEqual([
              '07-02T10:00 Event evt-r',
              '07-03T12:00 Moved again',
              '07-05T10:00 Event evt-r',
              '07-06T10:00 Event evt-r',
            ]);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        });
      });
    });

    it.effect('a cut’s exception deletes go with its landing: Google cancelled them', () => {
      // Verified live: the truncation cancels July 3 and July 4 and gives
      // them new etags, so their deletes' If-Match met a 412 and parked.
      let deletes = 0;
      const truncated = { ...series, etag: '"evt-r-t"', recurrence: ['RRULE:FREQ=DAILY;COUNT=1'] };
      const client: GoogleCalendarClientShape = {
        ...stubClient([firstPage]),
        deleteEvent: ({ calendarId, eventId }) => {
          deletes++;
          return Effect.fail(new ConflictError({ calendarId, eventId }));
        },
        getEvent: () => Effect.succeed({ ...cancelled, etag: '"c-t"' }),
        patchEvent: () => Effect.succeed(truncated),
      };
      return Effect.gen(function* () {
        yield* seedAccount;
        yield* (yield* SyncEngine).syncAll();
        const mutations = yield* EventMutations;
        yield* mutations.deleteRecurring({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          masterId: 'evt-r',
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'following',
        });
        yield* mutations.processPendingOps();
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        expect(deletes).toBe(0);
        expect(yield* shown).toEqual(['07-02T10:00 Event evt-r']);
        expect(yield* strays).toEqual([]);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    it.effect(
      'an occurrence deleted after the series grew back past an in-flight cut stays deleted',
      () => {
        // The cut's PATCH is out when the series becomes twelve days and
        // July 5 is deleted. The cut's landing took July 5's delete along:
        // July 5 came back on Google with the twelve days, hidden here.
        const requested = Effect.runSync(Deferred.make<void>());
        const release = Effect.runSync(Deferred.make<void>());
        let cutSent = false;
        const deletes: Array<string> = [];
        const truncated = {
          ...series,
          etag: '"evt-r-t"',
          recurrence: ['RRULE:FREQ=DAILY;COUNT=1'],
        };
        const twelve = { ...series, etag: '"evt-r-12"', recurrence: ['RRULE:FREQ=DAILY;COUNT=12'] };
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage]),
          deleteEvent: ({ eventId }) => {
            deletes.push(eventId);
            return Effect.void;
          },
          getEvent: () => Effect.succeed({ ...cancelled, etag: '"c-t"' }),
          patchEvent: () => {
            if (cutSent) {
              return Effect.succeed(twelve);
            }
            cutSent = true;
            return Deferred.succeed(requested, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(truncated),
            );
          },
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          yield* (yield* SyncEngine).syncAll();
          const mutations = yield* EventMutations;
          const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
          yield* mutations.deleteRecurring({
            ...at,
            originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
            scope: 'following',
          });
          const sending = yield* Effect.forkChild(mutations.processPendingOps());
          yield* Deferred.await(requested);
          yield* mutations.updateRecurring({
            ...at,
            changes: { recurrence: ['RRULE:FREQ=DAILY;COUNT=12'] },
            originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
            scope: 'series',
          });
          const july5 = 'evt-r_20260705T100000Z';
          yield* mutations.deleteRecurring({
            ...at,
            originalStartUtc: Date.parse('2026-07-05T10:00:00Z'),
            scope: 'instance',
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(sending);
          yield* mutations.retryPendingOps();
          yield* mutations.processPendingOps();
          yield* mutations.processPendingOps();
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
          expect(deletes).toContain(july5);
          expect(yield* shown).not.toContain('07-05T10:00 Event evt-r');
        }).pipe(Effect.provide(engineLayer(client)));
      },
    );

    it.effect('a series grown back past an unsent cut keeps the exceptions the cut dropped', () => {
      // Offline: "July 3 and following" deleted, then the series made twelve
      // days. The cut's deletes went out ahead of the twelve days and
      // cancelled July 3 on Google, which kept it cancelled under them.
      let online = false;
      const deletes: Array<string> = [];
      const twelve = { ...series, etag: '"evt-r-12"', recurrence: ['RRULE:FREQ=DAILY;COUNT=12'] };
      const client: GoogleCalendarClientShape = {
        ...stubClient([firstPage]),
        deleteEvent: ({ eventId }) => {
          deletes.push(eventId);
          return Effect.void;
        },
        patchEvent: () =>
          online
            ? Effect.succeed(twelve)
            : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      };
      const grown = [
        '07-02T10:00 Event evt-r',
        '07-03T12:00 Moved',
        '07-05T10:00 Event evt-r',
        '07-06T10:00 Event evt-r',
        '07-07T10:00 Event evt-r',
      ];
      return Effect.gen(function* () {
        yield* seedAccount;
        yield* (yield* SyncEngine).syncAll();
        const mutations = yield* EventMutations;
        const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
        yield* mutations.deleteRecurring({
          ...at,
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'following',
        });
        yield* mutations.updateRecurring({
          ...at,
          changes: { recurrence: ['RRULE:FREQ=DAILY;COUNT=12'] },
          originalStartUtc: Date.parse('2026-07-02T10:00:00Z'),
          scope: 'series',
        });
        expect(yield* shown).toEqual(grown);
        online = true;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        expect(deletes).toEqual([]);
        expect(yield* shown).toEqual(grown);
        expect(yield* strays).toEqual([]);
      }).pipe(Effect.provide(engineLayer(client)));
    });

    describe('after a rule change', () => {
      // Twelve days: the new rule still draws July 3 and July 4, and Google
      // keeps their exceptions (verified live).
      const twelve = ['RRULE:FREQ=DAILY;COUNT=12'];
      const extended = { ...renamed, etag: '"evt-r-12"', recurrence: twelve };
      // Every third day: July 3 and July 4 are no slots of it, and Google
      // cancels their exceptions with the PATCH. Their deletes are queued
      // ahead of the master's update.
      const everyThird = ['RRULE:FREQ=DAILY;INTERVAL=3;COUNT=4'];
      const skipping = { ...renamed, etag: '"evt-r-3d"', recurrence: everyThird };
      const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'evt-r' } as const;
      const july2 = Date.parse('2026-07-02T10:00:00Z');
      const changeRuleTo = (recurrence: Array<string>) =>
        Effect.gen(function* () {
          yield* (yield* EventMutations).updateRecurring({
            ...at,
            changes: { recurrence, title: 'Daily (Google)' },
            originalStartUtc: july2,
            scope: 'series',
          });
        });
      const changeRule = changeRuleTo(twelve);
      const editJuly3 = Effect.gen(function* () {
        yield* (yield* EventMutations).updateRecurring({
          ...at,
          changes: { title: 'Edited' },
          originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
          scope: 'instance',
        });
      });
      /** Lands what is due now, and what failed before once `online` lets it. */
      const drain = Effect.gen(function* () {
        const mutations = yield* EventMutations;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
      });
      /** The twelve days as Google draws them: July 3 moved, July 4 cancelled. */
      const kept = [
        '07-02T10:00 Daily (Google)',
        '07-03T12:00 Daily (Google)',
        '07-05T10:00 Daily (Google)',
        '07-06T10:00 Daily (Google)',
        '07-07T10:00 Daily (Google)',
      ];
      const skipped = ['07-02T10:00 Daily (Google)', '07-05T10:00 Daily (Google)'];

      it.effect('Google keeps the exceptions whose slots it still draws, and so do we', () => {
        // Verified live: the PATCH leaves July 3 moved and July 4 cancelled
        // (new etags, and the changed title carried onto July 3).
        const deletes: Array<string> = [];
        const client: GoogleCalendarClientShape = {
          ...stubClient([
            firstPage,
            {
              items: [
                extended,
                movedOccurrence('Daily (Google)', '"x-12"'),
                { ...cancelled, etag: '"c-12"' },
              ],
              nextSyncToken: 's2',
            },
          ]),
          deleteEvent: ({ eventId }) => {
            deletes.push(eventId);
            return Effect.void;
          },
          patchEvent: () => Effect.succeed(extended),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          yield* engine.syncAll();
          yield* changeRule;
          expect(yield* shown).toEqual(kept);
          yield* drain;
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
          expect(deletes).toEqual([]);
          expect(yield* shown).toEqual(kept);
          yield* engine.syncAll();
          expect(yield* shown).toEqual(kept);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('the deletes of the ones it skips wait behind it and go with its landing', () => {
        // Every other day: July 3 is no slot of it any more, and Google
        // cancels its exception with the PATCH, giving it a new etag. Sent
        // first, July 3's delete was a request for nothing; sent after, its
        // If-Match met a 412 and parked.
        const everyOther = ['RRULE:FREQ=DAILY;INTERVAL=2;COUNT=6'];
        let deletes = 0;
        let online = false;
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage]),
          deleteEvent: ({ calendarId, eventId }) => {
            deletes++;
            return Effect.fail(new ConflictError({ calendarId, eventId }));
          },
          patchEvent: () =>
            online
              ? Effect.succeed({ ...renamed, etag: '"evt-r-2d"', recurrence: everyOther })
              : Effect.fail(new ApiUnavailableError({ cause: '503' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          yield* (yield* SyncEngine).syncAll();
          yield* (yield* EventMutations).updateRecurring({
            ...at,
            changes: { recurrence: everyOther, title: 'Daily (Google)' },
            originalStartUtc: july2,
            scope: 'series',
          });
          yield* drain;
          online = true;
          yield* drain;
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
          expect(deletes).toBe(0);
          expect(yield* shown).toEqual([
            '07-02T10:00 Daily (Google)',
            '07-06T10:00 Daily (Google)',
          ]);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('once it reached Google, the exceptions it keeps stay', () => {
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage, { items: [extended], nextSyncToken: 's2' }]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          patchEvent: ({ eventId }) =>
            eventId === 'evt-r'
              ? Effect.succeed(extended)
              : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          const mutations = yield* EventMutations;
          yield* engine.syncAll();
          yield* changeRule;
          yield* mutations.processPendingOps();
          expect(yield* opOf('evt-r', 'update')).toBeUndefined();

          // A pull re-sends the master, and a series edit is discarded since.
          yield* engine.syncAll();
          expect(yield* shown).toEqual(kept);
          yield* mutations.updateRecurring({
            ...at,
            changes: { title: 'Renamed' },
            originalStartUtc: july2,
            scope: 'series',
          });
          yield* mutations.discardPendingOp((yield* opOf('evt-r', 'update'))!.id);
          expect(yield* shown).toEqual(kept);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('also when a series edit replaced it before it went out', () => {
        let online = false;
        const renamedRule = { ...extended, summary: 'Renamed' };
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage, { items: [renamedRule], nextSyncToken: 's2' }]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          patchEvent: ({ eventId }) =>
            online && eventId === 'evt-r'
              ? Effect.succeed(renamedRule)
              : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          yield* engine.syncAll();
          yield* changeRule;
          yield* (yield* EventMutations).updateRecurring({
            ...at,
            changes: { title: 'Renamed' },
            originalStartUtc: july2,
            scope: 'series',
          });
          online = true;
          yield* drain;
          expect(yield* opOf('evt-r', 'update')).toBeUndefined();
          yield* engine.syncAll();
          expect(yield* shown).toEqual(
            kept.map((line) => line.replace('Daily (Google)', 'Renamed')),
          );
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('also when its answer was lost and a retry found it on Google', () => {
        let patches = 0;
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage, { items: [extended], nextSyncToken: 's2' }]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          getEvent: () => Effect.succeed(extended),
          // The first attempt lands, its answer lost; the retry's If-Match is stale.
          patchEvent: ({ calendarId, eventId }) =>
            patches++ === 0
              ? Effect.fail(new ApiUnavailableError({ cause: 'lost' }))
              : Effect.fail(new ConflictError({ calendarId, eventId })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          yield* engine.syncAll();
          yield* changeRule;
          yield* drain;
          yield* drain;
          expect(yield* opOf('evt-r', 'update')).toBeUndefined();
          yield* engine.syncAll();
          expect(yield* shown).toEqual(kept);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect(
        'an occurrence edit made under it waits for it, also when its answer was lost',
        () => {
          // The rule change lands, its answer lost. Sent while it waited out
          // its backoff, the edit made an exception under the new rule that
          // the rule change's retry then took away.
          let patches = 0;
          const edited = {
            end: { dateTime: '2026-07-03T11:00:00Z' },
            etag: '"e-1"',
            id: july3,
            originalStartTime: { dateTime: '2026-07-03T10:00:00Z' },
            recurringEventId: 'evt-r',
            start: { dateTime: '2026-07-03T10:00:00Z' },
            status: 'confirmed',
            summary: 'Edited',
          };
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
            getEvent: () => Effect.succeed(extended),
            patchEvent: ({ calendarId, eventId }) => {
              if (eventId === july3) {
                return Effect.succeed(edited);
              }
              return patches++ === 0
                ? Effect.fail(new ApiUnavailableError({ cause: 'lost' }))
                : Effect.fail(new ConflictError({ calendarId, eventId }));
            },
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* changeRule;
            yield* editJuly3;
            yield* drain;
            yield* drain;
            expect(yield* opOf('evt-r', 'update')).toBeUndefined();
            expect(yield* opOf(july3, 'update')).toBeUndefined();
            expect(yield* shown).toContain('07-03T10:00 Edited');
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        },
      );

      it.effect('an edit of the event a cleared rule left still takes its deletes along', () => {
        // "Does not repeat", then the title, offline: the single event's
        // edit replaced the rule's update and lost its drop. July 3's and
        // July 4's deletes waited out a 503, met a 412 once the PATCH had
        // cancelled them, and parked.
        let online = false;
        const tried = new Set<string>();
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage]),
          deleteEvent: ({ calendarId, eventId }) => {
            if (!online || !tried.has(eventId)) {
              if (online) {
                tried.add(eventId);
              }
              return Effect.fail(new ApiUnavailableError({ cause: '503' }));
            }
            return Effect.fail(new ConflictError({ calendarId, eventId }));
          },
          patchEvent: () =>
            online
              ? Effect.succeed({ ...renamed, etag: '"evt-r-1"', recurrence: [], summary: 'Once' })
              : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          yield* (yield* SyncEngine).syncAll();
          const mutations = yield* EventMutations;
          yield* mutations.updateRecurring({
            ...at,
            changes: { recurrence: null },
            originalStartUtc: july2,
            scope: 'series',
          });
          yield* mutations.updateEvent({
            accountId: 'acc-1',
            calendarId: 'cal-1',
            changes: { title: 'Once' },
            eventId: 'evt-r',
          });
          online = true;
          yield* drain;
          yield* drain;
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('a slot Google’s ended rule cancelled shows plain once a new rule draws it', () => {
        // Another device ended the series on July 2; a full pull brought
        // July 3 and July 4 as cancelled exceptions past its end. Kept for
        // the twelve days, their tombstones hid July 3 and July 4, which
        // Google draws as plain occurrences again.
        const ended = { ...series, etag: '"evt-r-1"', recurrence: ['RRULE:FREQ=DAILY;COUNT=1'] };
        const deletes: Array<string> = [];
        const client: GoogleCalendarClientShape = {
          ...stubClient([
            firstPage,
            {
              items: [
                ended,
                { ...movedOccurrence('Moved', '"x-c"'), status: 'cancelled' },
                { ...cancelled, etag: '"c-c"' },
              ],
              nextSyncToken: 's2',
            },
          ]),
          deleteEvent: ({ eventId }) => {
            deletes.push(eventId);
            return Effect.void;
          },
          patchEvent: () => Effect.succeed(extended),
        };
        const plain = [
          '07-02T10:00 Daily (Google)',
          '07-03T10:00 Daily (Google)',
          '07-04T10:00 Daily (Google)',
          '07-05T10:00 Daily (Google)',
          '07-06T10:00 Daily (Google)',
          '07-07T10:00 Daily (Google)',
        ];
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          yield* engine.syncAll();
          yield* engine.syncAll();
          yield* changeRule;
          expect(yield* shown).toEqual(plain);
          yield* drain;
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
          expect(deletes).toEqual([]);
          expect(yield* shown).toEqual(plain);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect(
        'a second rule that draws again what the first skipped keeps those exceptions',
        () => {
          // Offline: every third day (it drops July 3 and July 4), then twelve
          // days. The first one's deletes went out ahead of the twelve days
          // and cancelled July 3 on Google, which then kept it cancelled.
          let online = false;
          const deletes: Array<string> = [];
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: ({ eventId }) => {
              deletes.push(eventId);
              return online
                ? Effect.void
                : Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
            },
            patchEvent: () =>
              online
                ? Effect.succeed(extended)
                : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* changeRuleTo(everyThird);
            yield* changeRule;
            expect(yield* shown).toEqual(kept);
            online = true;
            deletes.length = 0;
            yield* drain;
            yield* drain;
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(deletes).toEqual([]);
            expect(yield* shown).toEqual(kept);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        },
      );

      it.effect(
        'an occurrence deleted under a later rule that draws it again stays deleted',
        () => {
          // Every third day is out (it drops July 3) when twelve days replace
          // it, and July 3 is deleted under them. The first rule's landing
          // took that delete along as one of its own: July 3 came back on
          // Google with the twelve days, and stayed hidden here.
          const requested = Effect.runSync(Deferred.make<void>());
          const release = Effect.runSync(Deferred.make<void>());
          let firstSent = false;
          const deletes: Array<string> = [];
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: ({ eventId }) => {
              deletes.push(eventId);
              return Effect.void;
            },
            patchEvent: () => {
              if (firstSent) {
                return Effect.succeed(extended);
              }
              firstSent = true;
              return Deferred.succeed(requested, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(skipping),
              );
            },
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            const mutations = yield* EventMutations;
            yield* changeRuleTo(everyThird);
            // July 3's and July 4's deletes went first; the rule is out.
            const sending = yield* Effect.forkChild(mutations.processPendingOps());
            yield* Deferred.await(requested);
            deletes.length = 0;
            yield* changeRule;
            yield* mutations.deleteRecurring({
              ...at,
              originalStartUtc: Date.parse('2026-07-03T10:00:00Z'),
              scope: 'instance',
            });
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(sending);
            yield* drain;
            yield* drain;
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(deletes).toEqual([july3]);
            expect(yield* shown).not.toContain('07-03T10:00 Daily (Google)');
            expect(yield* shown).toContain('07-04T10:00 Daily (Google)');
          }).pipe(Effect.provide(engineLayer(client)));
        },
      );

      it.effect('a series edit that replaced it in flight drops nothing more once it lands', () => {
        // The rename made while the rule change was out inherits what it
        // drops. Once the rule change landed, the occurrence edit queued
        // between them went first, and the rename's landing took its
        // exception away.
        const requested = Effect.runSync(Deferred.make<void>());
        const release = Effect.runSync(Deferred.make<void>());
        let ruleSent = false;
        const edited = {
          end: { dateTime: '2026-07-03T11:00:00Z' },
          etag: '"e-1"',
          id: july3,
          originalStartTime: { dateTime: '2026-07-03T10:00:00Z' },
          recurringEventId: 'evt-r',
          start: { dateTime: '2026-07-03T10:00:00Z' },
          status: 'confirmed',
          summary: 'Edited',
        };
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          patchEvent: ({ eventId }) => {
            if (eventId === july3) {
              return Effect.succeed(edited);
            }
            if (ruleSent) {
              return Effect.succeed({ ...extended, summary: 'Renamed' });
            }
            ruleSent = true;
            return Deferred.succeed(requested, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(extended),
            );
          },
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          yield* (yield* SyncEngine).syncAll();
          const mutations = yield* EventMutations;
          yield* changeRule;
          const sending = yield* Effect.forkChild(mutations.processPendingOps());
          yield* Deferred.await(requested);
          yield* editJuly3;
          yield* mutations.updateRecurring({
            ...at,
            changes: { title: 'Renamed' },
            originalStartUtc: july2,
            scope: 'series',
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(sending);
          yield* drain;
          yield* drain;
          expect(yield* opOf('evt-r', 'update')).toBeUndefined();
          expect(yield* opOf(july3, 'update')).toBeUndefined();
          expect(yield* shown).toContain('07-03T10:00 Edited');
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect('an occurrence edit made meanwhile starts from Google’s exception', () => {
        // Discarded, the rule change leaves Google's July 3 as it was: the
        // edit's discard shows it again, not the slot.
        const client: GoogleCalendarClientShape = {
          ...stubClient([firstPage]),
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          yield* (yield* SyncEngine).syncAll();
          yield* changeRule;
          yield* editJuly3;
          const mutations = yield* EventMutations;
          yield* mutations.discardPendingOp((yield* opOf('evt-r', 'update'))!.id);
          yield* mutations.discardPendingOp((yield* opOf(july3, 'update'))!.id);
          expect(yield* shown).toEqual([
            '07-02T10:00 Event evt-r',
            '07-03T12:00 Moved',
            '07-05T10:00 Event evt-r',
            '07-06T10:00 Event evt-r',
          ]);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });

      it.effect(
        'and once the rule change lands, its discard goes back to Google’s exception',
        () => {
          let online = false;
          const client: GoogleCalendarClientShape = {
            ...stubClient([firstPage]),
            deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
            patchEvent: ({ eventId }) =>
              online && eventId === 'evt-r'
                ? Effect.succeed(extended)
                : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            yield* (yield* SyncEngine).syncAll();
            yield* changeRule;
            yield* editJuly3;
            online = true;
            yield* drain;
            expect(yield* opOf('evt-r', 'update')).toBeUndefined();
            // Google kept July 3, with the new title carried onto it.
            yield* (yield* EventMutations).discardPendingOp((yield* opOf(july3, 'update'))!.id);
            expect(yield* shown).toEqual(kept);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        },
      );

      it.effect(
        'a copy a pull sends while it waits stays off the new rule, for its discard',
        () => {
          const client: GoogleCalendarClientShape = {
            ...stubClient([
              firstPage,
              { items: [movedOccurrence('Moved again', '"x-2"')], nextSyncToken: 's2' },
            ]),
            deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
            patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          };
          return Effect.gen(function* () {
            yield* seedAccount;
            const engine = yield* SyncEngine;
            yield* engine.syncAll();
            yield* changeRuleTo(everyThird);
            yield* engine.syncAll();
            // Written as a row, the old rule's July 3 showed on its own.
            expect(yield* shown).toEqual(skipped);
            expect(yield* strays).toEqual([]);

            yield* (yield* EventMutations).discardPendingOp((yield* opOf('evt-r', 'update'))!.id);
            expect(yield* shown).toEqual([
              '07-02T10:00 Event evt-r',
              '07-03T12:00 Moved again',
              '07-05T10:00 Event evt-r',
              '07-06T10:00 Event evt-r',
            ]);
            expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
            expect(yield* strays).toEqual([]);
          }).pipe(Effect.provide(engineLayer(client)));
        },
      );

      it.effect('a copy that met a landed delete meanwhile goes once the rule lands', () => {
        // A pull sends July 3, changed on Google; its delete lands under the
        // queued rule, then the rule, which skips July 3: nothing of it stays.
        let online = false;
        const client: GoogleCalendarClientShape = {
          ...stubClient([
            firstPage,
            { items: [movedOccurrence('Moved again', '"x-2"')], nextSyncToken: 's2' },
          ]),
          deleteEvent: () =>
            online ? Effect.void : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          patchEvent: () =>
            online
              ? Effect.succeed(skipping)
              : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        };
        return Effect.gen(function* () {
          yield* seedAccount;
          const engine = yield* SyncEngine;
          yield* engine.syncAll();
          yield* changeRuleTo(everyThird);
          yield* engine.syncAll();
          online = true;
          yield* drain;
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
          expect(yield* shown).toEqual(skipped);
          expect(yield* strays).toEqual([]);
        }).pipe(Effect.provide(engineLayer(client)));
      });
    });
  });

  it.effect('a write queued during one calendar’s pass goes out before the next calendar’s', () => {
    // Each pass holds the drain, and the next one took the gate straight
    // back: a write waited out every calendar of the account (a first full
    // sync, a 503's backoff).
    const calls: Array<string> = [];
    const requested = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    let seeded = false;
    let held = false;
    const client: GoogleCalendarClientShape = {
      ...stubClient([]),
      deleteEvent: ({ eventId }) => {
        calls.push(`delete ${eventId}`);
        return Effect.void;
      },
      listCalendars: () =>
        Effect.succeed({
          items: [
            ...(calendarListPage.items ?? []),
            { accessRole: 'owner', id: 'cal-2', selected: true, summary: 'Work' },
          ],
          nextSyncToken: 'cal-sync-1',
        }),
      listEvents: ({ calendarId }) => {
        if (!seeded) {
          return Effect.succeed({
            items: calendarId === 'cal-1' ? [timedItem('evt-1', 10)] : [],
            nextSyncToken: 's1',
          });
        }
        calls.push(`list ${calendarId}`);
        if (held) {
          return Effect.succeed({ items: [], nextSyncToken: 's2' });
        }
        held = true;
        return Deferred.succeed(requested, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ items: [], nextSyncToken: 's2' }),
        );
      },
    };
    return Effect.gen(function* () {
      yield* seedAccount;
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      seeded = true;
      const syncing = yield* Effect.forkChild(engine.syncAll());
      yield* Deferred.await(requested);
      yield* (yield* EventMutations).deleteEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: 'evt-1',
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(syncing);
      expect(calls).toHaveLength(3);
      expect(calls[1]).toBe('delete evt-1');
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

  it.effect(
    'a calendar an incremental page added before the 410 goes if the relist omits it',
    () => {
      // Pages are stored as they arrive: page one of the delta adds a
      // calendar, page two answers 410, and the full list no longer has it.
      // The purge compared only with what was stored before the pass.
      const added = {
        accessRole: 'owner' as const,
        id: 'cal-brief',
        selected: true,
        summary: 'Brief',
      };
      let deltaExpires = false;
      const client: GoogleCalendarClientShape = {
        ...stubClient([]),
        listCalendars: (params) => {
          if (!params.syncToken) {
            return Effect.succeed({ items: calendarListPage.items, nextSyncToken: 'cal-sync-1' });
          }
          if (!deltaExpires) {
            return Effect.succeed({ items: [], nextSyncToken: 'cal-sync-1' });
          }
          return params.pageToken
            ? Effect.fail(new SyncTokenExpiredError({ calendarId: '' }))
            : Effect.succeed({ items: [added], nextPageToken: 'page-2' });
        },
      };
      return Effect.gen(function* () {
        yield* seedAccount;
        const engine = yield* SyncEngine;
        const ids = Effect.map((yield* CalendarRepo).list('acc-1'), (rows) =>
          rows.map((row) => row.id).sort(),
        );
        yield* engine.syncAll();
        deltaExpires = true;
        yield* engine.syncAll();
        expect(yield* ids).toEqual(['cal-1']);
      }).pipe(Effect.provide(engineLayer(client)));
    },
  );

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
