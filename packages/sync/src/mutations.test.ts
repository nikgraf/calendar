import { Account, CalendarInfo, plainDateToUtcMs, type EventDraft } from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  PendingOpRepo,
  reposLayer,
  runMigrations,
} from '@calendar/db';
import {
  ApiUnavailableError,
  ConflictError,
  GoogleCalendarClient,
  ReauthRequiredError,
  type GcalEvent,
  type GoogleCalendarClientShape,
} from '@calendar/google';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { EventMutations } from './mutations.ts';

type ClientOverrides = Partial<GoogleCalendarClientShape>;

const stubClient = (overrides: ClientOverrides): GoogleCalendarClientShape => ({
  deleteEvent: () => Effect.void,
  getColors: () => Effect.succeed({ calendar: {} }),
  insertEvent: () => Effect.die('unexpected insert'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  patchEvent: () => Effect.die('unexpected patch'),
  ...overrides,
});

const mutationsLayer = (client: GoogleCalendarClientShape) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, client)),
  );

const seedCalendar = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  yield* accounts.upsert(
    new Account({ createdAt: 1, email: 'nik@nikgraf.com', id: 'acc-1', status: 'ok' }),
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
    }).pipe(Effect.provide(mutationsLayer(client)));
  });

  it.effect('drops the op on 412 conflict (server wins)', () => {
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
      patchEvent: () => Effect.fail(new ConflictError({ calendarId: 'cal-1', eventId: 'e' })),
    });
    return Effect.gen(function* () {
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
      expect(ops).toHaveLength(0);
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
    }).pipe(Effect.provide(mutationsLayer(client)));
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
