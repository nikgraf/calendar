import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { Account, CalendarInfo, EventRecord, GeoLocation } from '@calendar/core';
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
  type GcalEvent,
  GoogleApiError,
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { EventMutations } from './mutations.ts';

/**
 * How Google answers the series patch: offline keeps the op queued, a 412
 * parks it (Google's copy is `server`), a 400 drops it.
 */
interface Google {
  patch: 'conflict' | 'offline' | 'reject';
  server?: GcalEvent;
}

const googleClient = (google: Google): GoogleCalendarClientShape => ({
  deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
  getColors: () => Effect.succeed({ calendar: {} }),
  getEvent: () =>
    google.server
      ? Effect.succeed(google.server)
      : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
  insertEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  moveEvent: () => Effect.die('unexpected move'),
  patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
  patchEvent: ({ eventId }) =>
    google.patch === 'conflict'
      ? Effect.fail(new ConflictError({ calendarId: 'cal-1', eventId }))
      : google.patch === 'reject'
        ? Effect.fail(new GoogleApiError({ message: 'Invalid value', status: 400 }))
        : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
});

const stubTasksClient: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('tasks not used in this test'),
  insertTask: () => Effect.die('tasks not used in this test'),
  listTaskLists: () => Effect.die('tasks not used in this test'),
  listTasks: () => Effect.die('tasks not used in this test'),
  patchTask: () => Effect.die('tasks not used in this test'),
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RULE = 'RRULE:FREQ=DAILY;COUNT=10';

const master = new EventRecord({
  accountId: 'acc-1',
  calendarId: 'cal-1',
  endUtc: Date.parse('2026-07-01T10:00:00Z'),
  etag: '"m-1"',
  id: 'master1',
  isAllDay: false,
  recurrence: [RULE],
  startTimeZone: 'UTC',
  startUtc: Date.parse('2026-07-01T09:00:00Z'),
  status: 'confirmed',
  syncedAt: 1,
  syncStatus: 'synced',
  title: 'Daily',
  updatedAt: 1,
});

const geo = new GeoLocation({ lat: 48.2, lng: 16.37, source: 'Stephansplatz 3, Wien' });

const exception = (day: number, fields: Partial<EventRecord>) => {
  const start = master.startUtc + day * DAY;
  return new EventRecord({
    ...master,
    endUtc: start + HOUR,
    etag: `"o-${day}"`,
    id: `master1_${new Date(start).toISOString().replaceAll(/[-:]|\.\d+/g, '')}`,
    originalStartUtc: start,
    recurrence: undefined,
    recurringEventId: 'master1',
    startUtc: start,
    ...fields,
  });
};

/** Its own title and a mapped location of its own. */
const moved = exception(3, { geo, location: geo.source, title: 'Daily (moved)' });
/** Still the series' text. */
const plain = exception(5, {});
const cancelled = exception(7, { status: 'cancelled', title: 'Old' });

const seed = Effect.gen(function* () {
  yield* (yield* AccountRepo).upsert(
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'acc-1@example.com',
      id: 'acc-1',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  );
  yield* (yield* CalendarRepo).upsertMany([
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-1',
      colorHex: '#3b82f6',
      id: 'cal-1',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: 'UTC',
    }),
  ]);
  yield* (yield* EventRepo).upsertMany([master, moved, plain, cancelled]);
});

const layer = (google: Google) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
    Layer.provideMerge(Layer.effectDiscard(seed)),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, googleClient(google))),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, stubTasksClient)),
  );

const series = (changes: { location?: string; title?: string }) =>
  Effect.gen(function* () {
    yield* (yield* EventMutations).updateRecurring({
      accountId: 'acc-1',
      calendarId: 'cal-1',
      changes,
      masterId: 'master1',
      originalStartUtc: master.startUtc,
      scope: 'series',
    });
  });

const row = (id: string) =>
  Effect.gen(function* () {
    return yield* (yield* EventRepo).getById('acc-1', 'cal-1', id);
  });

const text = (id: string) =>
  Effect.map(row(id), (event) => ({ location: event?.location, title: event?.title }));

const masterOp = Effect.gen(function* () {
  const ops = yield* (yield* PendingOpRepo).listAll();
  return ops.filter((op) => op.eventId === 'master1');
});

describe('a series edit carries text onto the exceptions, undoably', () => {
  it.effect('a rename reaches every live exception and records its own text', () =>
    Effect.gen(function* () {
      yield* series({ title: 'Standup' });

      expect(yield* text(moved.id)).toEqual({ location: geo.source, title: 'Standup' });
      expect((yield* text(plain.id)).title).toBe('Standup');
      expect((yield* text(cancelled.id)).title).toBe('Old');
      const [op] = yield* masterOp;
      expect(op?.carriedText?.base).toEqual({ description: null, location: null, title: 'Daily' });
      expect(op?.carriedText?.overrides).toEqual([
        { eventId: moved.id, title: 'Daily (moved)' },
        { eventId: plain.id, title: 'Daily' },
      ]);
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect("the editor's empty location is no change for a series without one", () =>
    Effect.gen(function* () {
      yield* series({ location: '', title: 'Standup' });

      const kept = yield* row(moved.id);
      expect(kept?.location).toBe(geo.source);
      expect(kept?.geo).toEqual(geo);
      expect((yield* masterOp)[0]?.carriedText?.overrides[0]).toEqual({
        eventId: moved.id,
        title: 'Daily (moved)',
      });
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect("a carried location drops the exception's stale coordinates", () =>
    Effect.gen(function* () {
      yield* series({ location: 'Karlsplatz' });

      const carried = yield* row(moved.id);
      expect(carried?.location).toBe('Karlsplatz');
      expect(carried?.geo).toBeUndefined();
      expect((yield* text(plain.id)).location).toBe('Karlsplatz');
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect('an offline rename and its revert leave the exceptions as Google does', () =>
    Effect.gen(function* () {
      yield* series({ title: 'Standup' });
      yield* series({ title: 'Daily' });

      // Google gets one patch with the title it already has, so it keeps
      // the exception's own title.
      expect((yield* text(moved.id)).title).toBe('Daily (moved)');
      expect((yield* text(plain.id)).title).toBe('Daily');
      const ops = yield* masterOp;
      expect(ops).toHaveLength(1);
      expect(ops[0]?.payload?.title).toBe('Daily');
      expect(ops[0]?.carriedText).toBeUndefined();
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect('coalesced renames keep the text from before the first', () =>
    Effect.gen(function* () {
      yield* series({ title: 'Standup' });
      yield* series({ title: 'Sync' });

      expect((yield* text(moved.id)).title).toBe('Sync');
      const [op] = yield* masterOp;
      expect(op?.carriedText?.base.title).toBe('Daily');
      expect(op?.carriedText?.overrides[0]).toEqual({ eventId: moved.id, title: 'Daily (moved)' });

      yield* (yield* EventMutations).discardPendingOp(op!.id);
      expect((yield* text(moved.id)).title).toBe('Daily (moved)');
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect("discarding the edit puts the exceptions' own text back", () =>
    Effect.gen(function* () {
      yield* series({ location: 'Karlsplatz', title: 'Standup' });
      const [op] = yield* masterOp;
      yield* (yield* EventMutations).discardPendingOp(op!.id);

      expect(yield* text(moved.id)).toEqual({ location: geo.source, title: 'Daily (moved)' });
      expect(yield* text(plain.id)).toEqual({ location: undefined, title: 'Daily' });
      expect((yield* row('master1'))?.syncStatus).toBe('synced');
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect("a rejected edit puts the exceptions' own text back", () =>
    Effect.gen(function* () {
      yield* series({ title: 'Standup' });
      yield* (yield* EventMutations).processPendingOps();

      expect(yield* masterOp).toEqual([]);
      expect((yield* text(moved.id)).title).toBe('Daily (moved)');
      expect((yield* text(plain.id)).title).toBe('Daily');
    }).pipe(Effect.provide(layer({ patch: 'reject' }))),
  );

  it.effect("taking Google's version puts the exceptions' own text back", () => {
    const google: Google = {
      patch: 'conflict',
      server: {
        end: { dateTime: '2026-07-01T10:00:00Z', timeZone: 'UTC' },
        etag: '"m-2"',
        id: 'master1',
        recurrence: [RULE],
        start: { dateTime: '2026-07-01T09:00:00Z', timeZone: 'UTC' },
        status: 'confirmed',
        summary: 'Daily',
      },
    };
    return Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* series({ title: 'Standup' });
      yield* mutations.processPendingOps();
      const [op] = yield* masterOp;
      expect(op?.conflictAt).toBeDefined();
      // While the user decides, the exceptions show the edit, like the master.
      expect((yield* text(moved.id)).title).toBe('Standup');

      yield* mutations.resolveConflict({ choice: 'theirs', opId: op!.id });
      expect((yield* row('master1'))?.title).toBe('Daily');
      expect((yield* text(moved.id)).title).toBe('Daily (moved)');
      expect((yield* text(plain.id)).title).toBe('Daily');
      expect(yield* masterOp).toEqual([]);
    }).pipe(Effect.provide(layer(google)));
  });

  it.effect('an exception edited after the carry keeps its newer text', () =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* series({ title: 'Standup' });
      yield* mutations.updateRecurring({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Custom' },
        masterId: 'master1',
        originalStartUtc: moved.originalStartUtc!,
        scope: 'instance',
      });
      // Reverting the series is no change on Google: the edited exception
      // keeps its title there too, the untouched one gets its own back.
      yield* series({ title: 'Daily' });
      expect((yield* text(moved.id)).title).toBe('Custom');
      expect((yield* text(plain.id)).title).toBe('Daily');

      yield* series({ title: 'Sync' });
      expect((yield* text(moved.id)).title).toBe('Sync');
      const [op] = yield* masterOp;
      yield* mutations.discardPendingOp(op!.id);
      expect((yield* text(moved.id)).title).toBe('Custom');
      expect((yield* text(plain.id)).title).toBe('Daily');
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect('splitting the series keeps the carry undoable', () =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* series({ title: 'Standup' });
      yield* mutations.updateRecurring({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Tail' },
        masterId: 'master1',
        originalStartUtc: master.startUtc + 8 * DAY,
        scope: 'following',
      });
      const [truncation] = yield* masterOp;
      expect(truncation?.payload?.recurrence?.[0]).toContain('UNTIL=');
      expect(truncation?.carriedText?.base.title).toBe('Daily');

      yield* mutations.discardPendingOp(truncation!.id);
      expect((yield* text(moved.id)).title).toBe('Daily (moved)');
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );
});
