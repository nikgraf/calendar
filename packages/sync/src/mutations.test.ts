import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import {
  Account,
  CalendarInfo,
  EventRecord,
  GeoLocation,
  plainDateToUtcMs,
  type EventDraft,
} from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  forwardingReactivity,
  PendingOpRepo,
  reposLayer,
  runMigrations,
} from '@calendar/db';
import { DROPPED_NOTICE_KEY } from '@calendar/db/keys';
import {
  ApiUnavailableError,
  ConflictError,
  type GcalEvent,
  GoogleApiError,
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
  NotFoundError,
  ReauthRequiredError,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Exit, Layer, Scheduler } from 'effect';
import { layer as reactivityLayer, type Reactivity } from 'effect/reactivity/Reactivity';
import { SqlClient } from 'effect/sql/SqlClient';
import { describe } from 'vitest';
import { EventMutations } from './mutations.ts';

type ClientOverrides = Partial<GoogleCalendarClientShape>;

/**
 * Keeps the drain that createEvent forks from running before the next
 * call: a test of a never-sent create must not see it attempted (and
 * stamped as sent) in between.
 */
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

const stubClient = (overrides: ClientOverrides): GoogleCalendarClientShape => ({
  deleteEvent: () => Effect.void,
  getColors: () => Effect.succeed({ calendar: {} }),
  getEvent: () => Effect.die('unexpected get'),
  insertCalendar: () => Effect.die('not used'),
  insertEvent: () => Effect.die('unexpected insert'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  moveEvent: () => Effect.die('unexpected move'),
  patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
  patchEvent: () => Effect.die('unexpected patch'),
  replaceEvent: () => Effect.die('not used'),
  ...overrides,
});

const stubTasksClient: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('tasks not used in this test'),
  insertTask: () => Effect.die('tasks not used in this test'),
  listTaskLists: () => Effect.die('tasks not used in this test'),
  listTasks: () => Effect.die('tasks not used in this test'),
  patchTask: () => Effect.die('tasks not used in this test'),
};

const mutationsLayer = (
  client: GoogleCalendarClientShape,
  reactivity: Layer.Layer<Reactivity> = reactivityLayer,
) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivity),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, client)),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, stubTasksClient)),
  );

const seedCalendar = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  yield* accounts.upsert(
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'nik@nikgraf.com',
      id: 'acc-1',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  );
  const calendars = yield* CalendarRepo;
  yield* calendars.upsertMany([
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-1',
      colorHex: '#3b82f6',
      id: 'cal-1',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: 'Europe/Vienna',
    }),
  ]);
});

const draft: EventDraft = {
  accountId: 'acc-1',
  calendarId: 'cal-1',
  endUtc: Date.parse('2026-07-03T11:00:00Z'),
  isAllDay: false,
  startTimeZone: 'Europe/Vienna',
  startUtc: Date.parse('2026-07-03T10:00:00Z'),
  title: 'New event',
};

const eventsNow = Effect.gen(function* () {
  const events = yield* EventRepo;
  const window = yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'));
  return window.singles;
});

/** A patched time as Google stores it: fields sent as null are gone. */
const storedTime = (time: unknown): GcalEvent['start'] =>
  time === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(time as Record<string, unknown>).filter(
          ([, value]) => typeof value === 'string',
        ),
      );

const echo = (
  event: {
    readonly end?: unknown;
    readonly start?: unknown;
    readonly summary?: string | undefined;
  },
  id: string,
  etag: string,
): GcalEvent => ({
  end: storedTime(event.end),
  etag,
  id,
  start: storedTime(event.start),
  status: 'confirmed',
  ...(event.summary === undefined ? {} : { summary: event.summary }),
});

/**
 * Google as If-Match sees it: a patch or delete carrying the stale
 * etag is a 412; one without If-Match (keep-mine) lands.
 */
const conflictingGoogle = (
  server: { current: GcalEvent | undefined; fetchFails?: boolean },
  sent: Array<{ readonly baseEtag: string | undefined; readonly kind: string }>,
) =>
  stubClient({
    deleteEvent: ({ baseEtag }) => {
      sent.push({ baseEtag, kind: 'delete' });
      return baseEtag
        ? Effect.fail(new ConflictError({ calendarId: 'cal-1', eventId: 'e' }))
        : Effect.void;
    },
    getEvent: () =>
      server.fetchFails
        ? Effect.fail(new ApiUnavailableError({ cause: 'offline' }))
        : server.current
          ? Effect.succeed(server.current)
          : Effect.fail(new NotFoundError({ resource: 'e' })),
    insertEvent: ({ event }) => {
      sent.push({ baseEtag: undefined, kind: 'insert' });
      return Effect.succeed(echo(event, event.id ?? 'x', '"server-1"'));
    },
    patchEvent: ({ baseEtag, event, eventId }) => {
      sent.push({ baseEtag, kind: 'patch' });
      return baseEtag
        ? Effect.fail(new ConflictError({ calendarId: 'cal-1', eventId }))
        : Effect.succeed(echo(event, eventId, '"server-3"'));
    },
  });

/** A synced event, then a local edit that meets a 412. */
const parkEdit = Effect.gen(function* () {
  yield* seedCalendar;
  const mutations = yield* EventMutations;
  const record = yield* mutations.createEvent(draft);
  yield* mutations.processPendingOps();
  yield* mutations.updateEvent({
    accountId: 'acc-1',
    calendarId: 'cal-1',
    changes: { title: 'Conflicting edit' },
    eventId: record.id,
  });
  yield* mutations.processPendingOps();
  const ops = yield* (yield* PendingOpRepo).listAll();
  return { mutations, op: ops[0]!, ops, record };
});

const rowOf = (id: string) =>
  Effect.gen(function* () {
    const events = yield* EventRepo;
    return yield* events.getById('acc-1', 'cal-1', id);
  });

describe('EventMutations', () => {
  it.effect('createEvent writes optimistically and syncs through the queue', () => {
    const inserted: Array<string> = [];
    const client = stubClient({
      insertEvent: ({ event }) => {
        inserted.push(event.id ?? '');
        return Effect.succeed({
          end: event.end as GcalEvent['end'],
          etag: '"server-1"',
          id: event.id ?? 'server-id',
          start: event.start as GcalEvent['start'],
          status: 'confirmed',
          summary: event.summary,
        });
      },
    });
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent(draft);
      expect(record.syncStatus).toBe('pending');

      yield* mutations.processPendingOps();

      const singles = yield* eventsNow;
      expect(singles).toHaveLength(1);
      expect(singles[0]!.syncStatus).toBe('synced');
      expect(singles[0]!.etag).toBe('"server-1"');
      expect(inserted).toEqual([record.id]);

      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops).toHaveLength(0);
    }).pipe(Effect.provide(mutationsLayer(client)));
  });

  it.effect('keeps the op queued with backoff while the API is unavailable', () => {
    const client = stubClient({
      insertEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
    });
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      yield* mutations.createEvent(draft);
      yield* mutations.processPendingOps();

      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops).toHaveLength(1);
      expect(ops[0]!.attempts).toBe(1);
      expect(ops[0]!.nextAttemptAt).toBeGreaterThan(0);

      const singles = yield* eventsNow;
      expect(singles[0]!.syncStatus).toBe('pending');
    }).pipe(Effect.provide(mutationsLayer(client)));
  });

  it.effect('updateEvent coalesces into a queued create', () => {
    const client = stubClient({});
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent(draft);
      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Renamed' },
        eventId: record.id,
      });

      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops).toHaveLength(1);
      expect(ops[0]!.kind).toBe('create');
      expect(ops[0]!.payload?.title).toBe('Renamed');

      const singles = yield* eventsNow;
      expect(singles[0]!.title).toBe('Renamed');
    }).pipe(noYield, Effect.provide(mutationsLayer(client)));
  });

  it.effect('a sent create may be on Google: an edit and a delete queue behind it', () => {
    // The first insert landed but its response was lost; the retry is a
    // 409 — "done" without sending anything new.
    const sent: Array<string> = [];
    const client = stubClient({
      deleteEvent: ({ eventId }) => {
        sent.push(`delete:${eventId}`);
        return Effect.void;
      },
      insertEvent: ({ event }) => {
        sent.push(`insert:${event.summary}`);
        return Effect.fail(
          sent.length === 1
            ? new ApiUnavailableError({ cause: 'response lost' })
            : new GoogleApiError({ message: 'duplicate', status: 409 }),
        );
      },
      patchEvent: ({ event, eventId }) => {
        sent.push(`patch:${event.summary}`);
        return Effect.succeed(echo(event, eventId, '"after-patch"'));
      },
    });
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      const ops = yield* PendingOpRepo;
      const record = yield* mutations.createEvent(draft);
      yield* mutations.processPendingOps();
      expect((yield* ops.listAll())[0]!.dispatchedAt).toBeDefined();

      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Renamed' },
        eventId: record.id,
      });
      expect((yield* ops.listAll()).map((op) => op.kind)).toEqual(['create', 'update']);
      for (const op of yield* ops.listAll()) {
        yield* ops.markFailed(op.id, op.attempts, 0, 'test');
      }
      yield* mutations.processPendingOps();
      // The rename reaches Google after the create's 409, instead of
      // riding in an insert Google ignores.
      expect(sent).toEqual(['insert:New event', 'insert:New event', 'patch:Renamed']);
      expect(yield* ops.listAll()).toEqual([]);
      expect((yield* rowOf(record.id))?.title).toBe('Renamed');

      // And a delete of a sent create is sent too.
      const second = yield* mutations.createEvent({ ...draft, title: 'Second' });
      sent.length = 0;
      yield* mutations.processPendingOps();
      yield* mutations.deleteEvent({ accountId: 'acc-1', calendarId: 'cal-1', eventId: second.id });
      expect((yield* ops.listAll()).map((op) => op.kind)).toEqual(['create', 'delete']);
      for (const op of yield* ops.listAll()) {
        yield* ops.markFailed(op.id, op.attempts, 0, 'test');
      }
      yield* mutations.processPendingOps();
      expect(sent).toEqual(['insert:Second', 'insert:Second', `delete:${second.id}`]);
      expect(yield* rowOf(second.id)).toBeNull();
    }).pipe(noYield, Effect.provide(mutationsLayer(client)));
  });

  it.effect('an empty location clears the field and reaches the patch body', () => {
    const patched: Array<Record<string, unknown>> = [];
    const client = stubClient({
      insertEvent: ({ event }) =>
        Effect.succeed({
          end: event.end as GcalEvent['end'],
          etag: '"server-1"',
          id: event.id ?? 'x',
          location: event.location,
          start: event.start as GcalEvent['start'],
          status: 'confirmed',
          summary: event.summary,
        }),
      patchEvent: ({ event }) => {
        patched.push(event as Record<string, unknown>);
        return Effect.succeed({
          end: storedTime(event.end),
          etag: '"server-2"',
          id: 'e',
          location: event.location,
          start: storedTime(event.start),
          status: 'confirmed',
          summary: event.summary,
        });
      },
    });
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent({ ...draft, location: 'Room 1' });
      yield* mutations.processPendingOps();

      // Undefined means "unchanged" — the location must survive.
      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Kept' },
        eventId: record.id,
      });
      expect((yield* eventsNow)[0]!.location).toBe('Room 1');

      // An empty string is an explicit clear.
      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { location: '' },
        eventId: record.id,
      });
      expect((yield* eventsNow)[0]!.location).toBe('');

      yield* mutations.processPendingOps();
      expect(patched.at(-1)?.location).toBe('');
    }).pipe(Effect.provide(mutationsLayer(client)));
  });

  it.effect('location coordinates follow the location text on every write', () => {
    const client = stubClient({
      insertEvent: ({ event }) =>
        Effect.succeed({
          end: event.end as GcalEvent['end'],
          etag: '"server-1"',
          extendedProperties: event.extendedProperties as GcalEvent['extendedProperties'],
          id: event.id ?? 'x',
          location: event.location,
          start: event.start as GcalEvent['start'],
          status: 'confirmed',
          summary: event.summary,
        }),
      patchEvent: () => Effect.die('stays queued'),
    });
    const geo = new GeoLocation({
      lat: 48.2,
      lng: 16.37,
      name: 'Naschmarkt',
      source: 'Naschmarkt',
    });
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      const pendingOps = yield* PendingOpRepo;

      // Coordinates that do not match the draft's location are never stored.
      const stray = yield* mutations.createEvent({ ...draft, geo, location: 'Office' });
      expect(stray.geo).toBeUndefined();

      const record = yield* mutations.createEvent({ ...draft, geo, location: 'Naschmarkt' });
      expect(record.geo).toEqual(geo);
      const queued = (yield* pendingOps.listAll()).find((op) => op.eventId === record.id);
      expect(queued?.payload?.geo).toEqual(geo);
      // Synced, so the edits below queue as updates (a queued create
      // absorbs edits and needs no delete flag: it sends no keys).
      yield* mutations.processPendingOps();

      const update = (changes: Parameters<typeof mutations.updateEvent>[0]['changes']) =>
        mutations.updateEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          changes,
          eventId: record.id,
        });
      const current = Effect.map(eventsNow, (events) => events.find((e) => e.id === record.id));

      const queuedFlag = Effect.map(
        pendingOps.listAll(),
        (ops) => ops.find((op) => op.eventId === record.id)?.geoCleared,
      );

      yield* update({ title: 'Lunch' });
      expect((yield* current)?.geo).toEqual(geo);
      expect(yield* queuedFlag).toBeUndefined();

      // Dropping coordinates flags the queued update to delete the keys…
      yield* update({ geo: null });
      expect((yield* current)?.geo).toBeUndefined();
      expect(yield* queuedFlag).toBe(true);
      // …and a later unrelated edit that replaces that op inherits the flag.
      yield* update({ title: 'Lunch again' });
      expect(yield* queuedFlag).toBe(true);

      yield* update({ geo, location: 'naschmarkt ' });
      expect((yield* current)?.geo).toEqual(geo);

      yield* update({ location: 'Somewhere else' });
      expect((yield* current)?.geo).toBeUndefined();
      expect(yield* queuedFlag).toBe(true);
    }).pipe(Effect.provide(mutationsLayer(client)));
  });

  describe('412 conflicts', () => {
    it.effect("parks the op with Google's version instead of dropping the edit", () => {
      const sent: Array<{ baseEtag: string | undefined; kind: string }> = [];
      const server = { current: undefined as GcalEvent | undefined };
      return Effect.gen(function* () {
        const pending = yield* parkEdit;
        expect(pending.ops).toHaveLength(1);
        expect(pending.op.conflictAt).toBeDefined();
        expect(pending.op.lastError).toBe('changed on Google');
        // The user's version stays on screen, protected from pulls.
        const row = yield* rowOf(pending.record.id);
        expect(row?.title).toBe('Conflicting edit');
        expect(row?.syncStatus).toBe('pending');

        // Parked ops are not retried.
        const before = sent.length;
        yield* pending.mutations.processPendingOps();
        expect(sent.length).toBe(before);
      }).pipe(Effect.provide(mutationsLayer(conflictingGoogle(server, sent))));
    });

    it.effect('stores the server copy for the comparison', () => {
      const sent: Array<{ baseEtag: string | undefined; kind: string }> = [];
      const server: { current: GcalEvent | undefined } = { current: undefined };
      const client = conflictingGoogle(server, sent);
      return Effect.gen(function* () {
        server.current = {
          end: { dateTime: '2026-07-03T12:00:00Z' },
          etag: '"server-2"',
          id: 'placeholder',
          start: { dateTime: '2026-07-03T11:00:00Z' },
          status: 'confirmed',
          summary: 'Server title',
        };
        const { op, record } = yield* parkEdit;
        expect(op.eventId).toBe(record.id);
        expect(op.serverPayload?.title).toBe('Server title');
        expect(op.serverPayload?.etag).toBe('"server-2"');
      }).pipe(Effect.provide(mutationsLayer(client)));
    });

    it.effect("retries instead of parking when Google's version cannot be fetched", () => {
      const sent: Array<{ baseEtag: string | undefined; kind: string }> = [];
      const server = { current: undefined, fetchFails: true };
      return Effect.gen(function* () {
        const { op } = yield* parkEdit;
        expect(op.conflictAt).toBeUndefined();
        expect(op.attempts).toBe(1);
        expect(op.lastError).toContain('ApiUnavailableError');
      }).pipe(Effect.provide(mutationsLayer(conflictingGoogle(server, sent))));
    });

    it.effect('keep mine re-sends the edit without If-Match', () => {
      const sent: Array<{ baseEtag: string | undefined; kind: string }> = [];
      const server: { current: GcalEvent | undefined } = { current: undefined };
      return Effect.gen(function* () {
        const { mutations, op, record } = yield* parkEdit;
        // Google still has the event (the fetch said so when parking).
        yield* (yield* PendingOpRepo).markConflict(op.id, 1, record);
        yield* mutations.resolveConflict({ choice: 'mine', opId: op.id });
        yield* mutations.processPendingOps();

        expect(sent.at(-1)).toEqual({ baseEtag: undefined, kind: 'patch' });
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        const row = yield* rowOf(record.id);
        expect(row?.title).toBe('Conflicting edit');
        expect(row?.syncStatus).toBe('synced');
      }).pipe(Effect.provide(mutationsLayer(conflictingGoogle(server, sent))));
    });

    it.effect('keep mine on an untitled event clears a title Google got meanwhile', () => {
      let server: GcalEvent | undefined;
      const client = stubClient({
        getEvent: () => Effect.succeed(server!),
        insertEvent: ({ event }) => {
          // Created untitled: Google stores no summary.
          server = { ...echo({ end: event.end, start: event.start }, event.id ?? 'x', '"v1"') };
          return Effect.succeed(server);
        },
        patchEvent: ({ baseEtag, event, eventId }) =>
          Effect.gen(function* () {
            if (baseEtag !== undefined && baseEtag !== server!.etag) {
              return yield* Effect.fail(new ConflictError({ calendarId: 'cal-1', eventId }));
            }
            server = {
              ...server!,
              ...(event.summary === undefined ? {} : { summary: event.summary }),
              etag: '"v3"',
            };
            return server;
          }),
      });
      return Effect.gen(function* () {
        yield* seedCalendar;
        const mutations = yield* EventMutations;
        const record = yield* mutations.createEvent({ ...draft, title: '(no title)' });
        yield* mutations.processPendingOps();
        expect((yield* rowOf(record.id))?.title).toBe('(no title)');
        // A local time change waits while someone names the event on Google.
        yield* mutations.updateEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          changes: { endUtc: draft.endUtc + 3_600_000 },
          eventId: record.id,
        });
        server = { ...server!, etag: '"v2"', summary: 'Lunch' };
        yield* mutations.processPendingOps();
        const [parked] = yield* (yield* PendingOpRepo).listAll();
        expect(parked?.conflictAt).toBeDefined();
        // The user keeps the untitled version: Google's title is cleared,
        // not kept and written over the local row.
        yield* mutations.resolveConflict({ choice: 'mine', opId: parked!.id });
        yield* mutations.processPendingOps();
        expect(server?.summary).toBe('');
        expect((yield* rowOf(record.id))?.title).toBe('(no title)');
      }).pipe(noYield, Effect.provide(mutationsLayer(client)));
    });

    it.effect('restore mine re-creates an event Google deleted', () => {
      const sent: Array<{ baseEtag: string | undefined; kind: string }> = [];
      const server: { current: GcalEvent | undefined } = { current: undefined };
      return Effect.gen(function* () {
        const { mutations, op, record } = yield* parkEdit;
        expect(op.serverPayload).toBeUndefined();
        yield* mutations.resolveConflict({ choice: 'mine', opId: op.id });
        yield* mutations.processPendingOps();

        expect(sent.at(-1)?.kind).toBe('insert');
        expect(yield* rowOf(record.id)).toBeNull();
        const titles = (yield* eventsNow).map((event) => event.title);
        expect(titles).toEqual(['Conflicting edit']);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }).pipe(Effect.provide(mutationsLayer(conflictingGoogle(server, sent))));
    });

    it.effect("take theirs replaces the local copy with Google's current version", () => {
      const sent: Array<{ baseEtag: string | undefined; kind: string }> = [];
      const server: { current: GcalEvent | undefined } = { current: undefined };
      return Effect.gen(function* () {
        const { mutations, op, record } = yield* parkEdit;
        // Google moved on again after the op was parked: the live copy wins.
        server.current = {
          end: { dateTime: '2026-07-03T12:00:00Z' },
          etag: '"server-4"',
          id: record.id,
          start: { dateTime: '2026-07-03T11:00:00Z' },
          status: 'confirmed',
          summary: 'Server title, later',
        };
        yield* mutations.resolveConflict({ choice: 'theirs', opId: op.id });

        const row = yield* rowOf(record.id);
        expect(row?.title).toBe('Server title, later');
        expect(row?.etag).toBe('"server-4"');
        expect(row?.syncStatus).toBe('synced');
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        // Resolving twice (the banner raced the queue) is a no-op.
        yield* mutations.resolveConflict({ choice: 'theirs', opId: op.id });
      }).pipe(Effect.provide(mutationsLayer(conflictingGoogle(server, sent))));
    });

    it.effect('take theirs drops the local copy of an event Google deleted', () => {
      const sent: Array<{ baseEtag: string | undefined; kind: string }> = [];
      const server: { current: GcalEvent | undefined } = { current: undefined };
      return Effect.gen(function* () {
        const { mutations, op, record } = yield* parkEdit;
        yield* mutations.resolveConflict({ choice: 'theirs', opId: op.id });
        expect(yield* rowOf(record.id)).toBeNull();
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }).pipe(Effect.provide(mutationsLayer(conflictingGoogle(server, sent))));
    });

    it.effect('a new edit of a parked event re-queues it and parks again', () => {
      const sent: Array<{ baseEtag: string | undefined; kind: string }> = [];
      const server: { current: GcalEvent | undefined } = { current: undefined };
      return Effect.gen(function* () {
        const { mutations, record } = yield* parkEdit;
        yield* mutations.updateEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          changes: { title: 'Second edit' },
          eventId: record.id,
        });
        yield* mutations.processPendingOps();
        const ops = yield* (yield* PendingOpRepo).listAll();
        expect(ops).toHaveLength(1);
        expect(ops[0]?.conflictAt).toBeDefined();
        expect(ops[0]?.payload?.title).toBe('Second edit');
      }).pipe(Effect.provide(mutationsLayer(conflictingGoogle(server, sent))));
    });

    it.effect('discarding a queued edit hands its row back to sync', () => {
      const sent: Array<{ baseEtag: string | undefined; kind: string }> = [];
      const server: { current: GcalEvent | undefined } = { current: undefined };
      return Effect.gen(function* () {
        const { mutations, op, record } = yield* parkEdit;
        yield* mutations.discardPendingOp(op.id);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        expect((yield* rowOf(record.id))?.syncStatus).toBe('synced');
      }).pipe(Effect.provide(mutationsLayer(conflictingGoogle(server, sent))));
    });
  });

  it.effect('a permanent 4xx drops the op and broadcasts the dropped notice', () => {
    const client = stubClient({
      insertEvent: ({ event }) =>
        Effect.succeed({
          end: event.end as GcalEvent['end'],
          etag: '"server-1"',
          id: event.id ?? 'x',
          start: event.start as GcalEvent['start'],
          status: 'confirmed',
          summary: event.summary,
        }),
      patchEvent: () =>
        Effect.fail(new GoogleApiError({ message: 'Invalid value for field', status: 400 })),
    });
    const seen: Array<unknown> = [];
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent(draft);
      yield* mutations.processPendingOps();

      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Rejected edit' },
        eventId: record.id,
      });
      yield* mutations.processPendingOps();

      // Dropped, not pinned in the queue — and the UI hears about it,
      // where it used to vanish without a trace.
      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops).toHaveLength(0);
      expect(seen).toContain(DROPPED_NOTICE_KEY);
    }).pipe(
      Effect.provide(
        mutationsLayer(
          client,
          forwardingReactivity((keys) => {
            seen.push(...keys);
          }),
        ),
      ),
    );
  });

  it.effect('a create Google rejects for good takes its optimistic event with it', () => {
    const client = stubClient({
      insertEvent: () =>
        Effect.fail(new GoogleApiError({ message: 'Invalid value for start', status: 400 })),
    });
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent(draft);
      yield* mutations.processPendingOps();

      expect(yield* (yield* PendingOpRepo).listAll()).toHaveLength(0);
      const events = yield* EventRepo;
      expect(yield* events.getById('acc-1', 'cal-1', record.id)).toBeNull();
    }).pipe(Effect.provide(mutationsLayer(client)));
  });

  it.effect('a failed queue write rolls the local edit back with it', () => {
    const client = stubClient({
      insertEvent: ({ event }) =>
        Effect.succeed({
          end: event.end as GcalEvent['end'],
          etag: '"server-1"',
          id: event.id ?? 'x',
          start: event.start as GcalEvent['start'],
          status: 'confirmed',
          summary: event.summary,
        }),
    });
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent(draft);
      yield* mutations.processPendingOps();

      // Break the queue between the local write and the enqueue: the
      // row must not stay behind as a pending edit no op will ever push.
      const sql = yield* SqlClient;
      yield* sql`DROP TABLE pending_ops`;
      const outcome = yield* Effect.exit(
        mutations.updateEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          changes: { title: 'Lost edit' },
          eventId: record.id,
        }),
      );
      expect(Exit.isFailure(outcome)).toBe(true);
      const events = yield* EventRepo;
      const row = yield* events.getById('acc-1', 'cal-1', record.id);
      expect(row?.title).toBe(record.title);
      expect(row?.syncStatus).toBe('synced');
    }).pipe(Effect.provide(mutationsLayer(client)));
  });

  it.effect('a transient failure records its reason on the queued op', () => {
    const client = stubClient({
      insertEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'connection reset' })),
    });
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      yield* mutations.createEvent(draft);
      yield* mutations.processPendingOps();

      const [op] = yield* (yield* PendingOpRepo).listAll();
      expect(op?.attempts).toBe(1);
      expect(op?.lastError).toContain('connection reset');
    }).pipe(Effect.provide(mutationsLayer(client)));
  });

  it.effect('a 401 during an op flags the account and keeps the op queued', () => {
    const client = stubClient({
      insertEvent: () => Effect.fail(new ReauthRequiredError({ accountId: 'acc-1' })),
    });
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      yield* mutations.createEvent(draft);
      yield* mutations.processPendingOps();

      const accounts = yield* (yield* AccountRepo).list();
      expect(accounts[0]!.status).toBe('reauth_required');
      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops).toHaveLength(1);
    }).pipe(Effect.provide(mutationsLayer(client)));
  });

  it.effect('drops permanently-rejected ops but keeps transient failures queued', () =>
    Effect.gen(function* () {
      const attempt = (status: number) =>
        Effect.gen(function* () {
          const mutations = yield* EventMutations;
          const record = yield* mutations.createEvent({
            ...draft,
            title: `evt-${status}`,
          });
          yield* mutations.processPendingOps();
          const remaining = (yield* (yield* PendingOpRepo).listAll()).filter(
            (op) => op.eventId === record.id,
          );
          return remaining;
        }).pipe(
          Effect.provide(
            mutationsLayer(
              stubClient({
                insertEvent: () => Effect.fail(new GoogleApiError({ message: 'boom', status })),
              }),
            ),
          ),
        );

      // 4xx (except 429) are the app's fault and would pin the queue forever.
      for (const status of [400, 403, 404]) {
        expect(yield* attempt(status), `status ${status}`).toHaveLength(0);
      }
      // 409 means the idempotent create already landed.
      expect(yield* attempt(409)).toHaveLength(0);
      // Server-side and rate-limit failures must be retried.
      for (const status of [429, 500, 503]) {
        const remaining = yield* attempt(status);
        expect(remaining, `status ${status}`).toHaveLength(1);
        expect(remaining[0]!.attempts).toBe(1);
        // Backed off rather than hammered.
        expect(remaining[0]!.nextAttemptAt).toBeGreaterThan(0);
      }
    }),
  );

  it.effect('refuses edits, deletes and moves of an event in a read-only calendar', () => {
    const client = stubClient({});
    return Effect.gen(function* () {
      yield* seedCalendar;
      yield* (yield* CalendarRepo).upsertMany([
        new CalendarInfo({
          accessRole: 'reader',
          accountId: 'acc-1',
          colorHex: '#16a765',
          id: 'shared',
          isPrimary: false,
          isVisible: true,
          provider: 'google',
          summary: 'Team (view only)',
          timeZone: 'Europe/Vienna',
        }),
      ]);
      const stored = new EventRecord({
        accountId: 'acc-1',
        calendarId: 'shared',
        endUtc: draft.endUtc,
        etag: '"s-1"',
        id: 'shared-1',
        isAllDay: false,
        startTimeZone: 'Europe/Vienna',
        startUtc: draft.startUtc,
        status: 'confirmed',
        syncedAt: 1,
        syncStatus: 'synced',
        title: 'Their meeting',
        updatedAt: 1,
      });
      const events = yield* EventRepo;
      yield* events.upsertMany([stored]);
      const mutations = yield* EventMutations;
      const ref = { accountId: 'acc-1', calendarId: 'shared', eventId: 'shared-1' };
      // Each mutation fails its own way; all must fail as not writable.
      const refusals: ReadonlyArray<Effect.Effect<void, { readonly _tag: string }>> = [
        // A drag: Google would 403, and the drop marked the moved row synced.
        mutations.updateEvent({
          ...ref,
          changes: { endUtc: draft.endUtc + 3_600_000, startUtc: draft.startUtc + 3_600_000 },
        }),
        mutations.deleteEvent(ref),
        mutations.updateRecurring({
          ...ref,
          changes: { title: 'x' },
          masterId: 'shared-1',
          originalStartUtc: draft.startUtc,
          scope: 'instance',
        }),
        mutations.moveEvent({ ...ref, target: { accountId: 'acc-1', calendarId: 'cal-1' } }),
      ];
      for (const refusal of refusals) {
        expect((yield* Effect.flip(refusal))._tag).toBe('CalendarNotWritableError');
      }
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      expect(yield* events.getById('acc-1', 'shared', 'shared-1')).toEqual(stored);
    }).pipe(Effect.provide(mutationsLayer(client)));
  });

  it.effect('deleting a never-synced event needs no server op', () => {
    const client = stubClient({});
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent(draft);
      yield* mutations.deleteEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: record.id,
      });

      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops).toHaveLength(0);
      const singles = yield* eventsNow;
      expect(singles).toHaveLength(0);
    }).pipe(noYield, Effect.provide(mutationsLayer(client)));
  });

  it.effect('deleting a synced event enqueues a delete with If-Match', () => {
    const deletes: Array<string | undefined> = [];
    const client = stubClient({
      deleteEvent: ({ baseEtag }) => {
        deletes.push(baseEtag);
        return Effect.void;
      },
      insertEvent: ({ event }) =>
        Effect.succeed({
          end: event.end as GcalEvent['end'],
          etag: '"server-9"',
          id: event.id ?? 'x',
          start: event.start as GcalEvent['start'],
          status: 'confirmed',
          summary: event.summary,
        }),
    });
    return Effect.gen(function* () {
      yield* seedCalendar;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent(draft);
      yield* mutations.processPendingOps();

      yield* mutations.deleteEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: record.id,
      });
      yield* mutations.processPendingOps();

      expect(deletes).toEqual(['"server-9"']);
      const singles = yield* eventsNow;
      expect(singles).toHaveLength(0);
    }).pipe(Effect.provide(mutationsLayer(client)));
  });
});
