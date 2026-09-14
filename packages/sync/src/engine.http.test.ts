import { Account } from '@calendar/core';
import {
  AccountRepo,
  BirthdayRepo,
  CalendarRepo,
  EventRepo,
  PendingOpRepo,
  reposLayer,
  runMigrations,
  TaskRepo,
} from '@calendar/db';
import {
  GOOGLE_BIRTHDAYS_CALENDAR_ID,
  GoogleCalendarClient,
  GooglePeopleClient,
  GoogleTasksClient,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer, Scheduler } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';
import { FakeGoogle } from './testing/fakeGoogle.ts';

/**
 * The engine, the mutations and the real Google clients against the
 * in-process fake API (testing/fakeGoogle.ts). engine.test.ts scripts the
 * client shapes; these tests exercise the HTTP layer, the request core's
 * status mapping and the sync protocol end to end.
 */

const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

const engineLayer = (google: FakeGoogle) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(GoogleCalendarClient.layer),
    Layer.provideMerge(GoogleTasksClient.layer),
    Layer.provideMerge(GooglePeopleClient.layer),
    Layer.provideMerge(google.layer),
  );

const seedAccount = (tasksEnabled: boolean, contactsEnabled = false) =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo;
    yield* accounts.upsert(
      new Account({
        contactsEnabled,
        createdAt: 1,
        email: 'nik@example.com',
        id: 'acc-1',
        provider: 'google',
        status: 'ok',
        tasksEnabled,
      }),
    );
  });

const timed = (id: string, hour: number, summary = `Event ${id}`) => ({
  end: { dateTime: `2026-07-02T${String(hour + 1).padStart(2, '0')}:00:00Z` },
  id,
  start: { dateTime: `2026-07-02T${String(hour).padStart(2, '0')}:00:00Z` },
  status: 'confirmed',
  summary,
});

const newFake = () =>
  new FakeGoogle({
    calendars: [{ accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' }],
    taskLists: [{ id: 'list-1', title: 'My Tasks' }],
  });

const eventTitles = Effect.gen(function* () {
  const events = yield* EventRepo;
  const window = yield* events.getWindow(0, Number.MAX_SAFE_INTEGER);
  return window.singles.map((event) => `${event.id}:${event.title}`).sort();
});

describe('SyncEngine over HTTP (fake Google)', () => {
  it.effect('birthdays come from People, and the Birthdays calendar is never synced', () => {
    const google = new FakeGoogle({
      calendars: [
        { accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' },
        { accessRole: 'reader', id: GOOGLE_BIRTHDAYS_CALENDAR_ID, summary: 'Birthdays' },
      ],
      people: [
        {
          birthdays: [{ date: { day: 4, month: 3, year: 1994 } }],
          names: [{ displayName: 'Alice Example' }],
          resourceName: 'people/c1',
        },
      ],
    });
    return Effect.gen(function* () {
      yield* seedAccount(false, true);
      yield* (yield* SyncEngine).syncAll();
      const calendars = yield* (yield* CalendarRepo).list('acc-1');
      expect(calendars.map((calendar) => calendar.id)).toEqual(['cal-1']);
      expect(
        google.requests.some((request) => request.url.includes('addressbook%23contacts')),
      ).toBe(false);
      const birthdays = yield* (yield* BirthdayRepo).listAll();
      expect(birthdays.map((row) => [row.displayName, row.month, row.day, row.year])).toEqual([
        ['Alice Example', 3, 4, 1994],
      ]);
      const connections = google.requests.find((request) => request.url.includes('/connections'));
      const others = google.requests.find((request) => request.url.includes('/otherContacts'));
      expect(new URL(connections!.url).searchParams.get('personFields')).toContain('birthdays');
      expect(new URL(others!.url).searchParams.get('readMask')).not.toContain('birthdays');
    }).pipe(Effect.provide(engineLayer(google)));
  });

  it.effect('a full pass stores the calendar and its events; the next pass is incremental', () => {
    const google = newFake();
    google.putEvent('cal-1', timed('a', 9));
    google.putEvent('cal-1', timed('b', 11));
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      expect(yield* eventTitles).toEqual(['a:Event a', 'b:Event b']);

      // Server-side edit + delete: the second pass sends the sync token
      // and applies only the two changes (the tombstone removes b).
      google.putEvent('cal-1', timed('a', 9, 'Renamed a'));
      google.cancelEvent('cal-1', 'b');
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect(yield* eventTitles).toEqual(['a:Renamed a']);
      const listCalls = google.requests.filter(
        (call) => call.method === 'GET' && call.url.includes('/calendars/cal-1/events'),
      );
      expect(listCalls[0]!.url).not.toContain('syncToken=');
      expect(listCalls[1]!.url).toContain('syncToken=cal-1%3A2');
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('an expired sync token (410) forces a full resync that drops vanished rows', () => {
    const google = newFake();
    google.putEvent('cal-1', timed('a', 9));
    google.putEvent('cal-1', timed('b', 11));
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();

      // While our token was expiring, b was deleted and its tombstone
      // aged out: a full pass must notice b is gone without ever seeing
      // a tombstone for it.
      google.expireSyncTokens('cal-1');
      google.cancelEvent('cal-1', 'b');
      // passStartedAt must move on for deleteStale to see b as untouched.
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect(yield* eventTitles).toEqual(['a:Event a']);
      const statuses = google.requests
        .filter((call) => call.method === 'GET' && call.url.includes('/events'))
        .map((call) => (call.url.includes('syncToken=') ? 'incremental' : 'full'));
      expect(statuses).toEqual(['full', 'incremental', 'full']);
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('a local edit patches with If-Match; a stale etag is a 412 and the server wins', () => {
    const google = newFake();
    google.putEvent('cal-1', timed('a', 9));
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      const mutations = yield* EventMutations;
      yield* engine.syncAll();

      // Edit 1 lands: PATCH with the etag we hold.
      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Local 1' },
        eventId: 'a',
      });
      yield* mutations.processPendingOps();
      expect(google.eventOf('cal-1', 'a')?.summary).toBe('Local 1');
      expect(yield* (yield* PendingOpRepo).listAll()).toHaveLength(0);

      // The server moves on behind our back; our next edit carries the
      // old etag → 412 → dropped, and the pull restores the server copy.
      google.putEvent('cal-1', timed('a', 9, 'Server 2'));
      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Local 2' },
        eventId: 'a',
      });
      yield* mutations.processPendingOps();
      expect(google.eventOf('cal-1', 'a')?.summary).toBe('Server 2');
      expect(yield* (yield* PendingOpRepo).listAll()).toHaveLength(0);
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect(yield* eventTitles).toEqual(['a:Server 2']);
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('a local create posts the client id and the response acks the row', () => {
    const google = newFake();
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      const mutations = yield* EventMutations;
      yield* engine.syncAll();
      const record = yield* mutations.createEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        endUtc: Date.parse('2026-07-03T10:00:00Z'),
        isAllDay: false,
        startTimeZone: 'UTC',
        startUtc: Date.parse('2026-07-03T09:00:00Z'),
        title: 'Created here',
      });
      yield* mutations.processPendingOps();
      expect(google.eventOf('cal-1', record.id)?.summary).toBe('Created here');
      const events = yield* EventRepo;
      expect((yield* events.getById('acc-1', 'cal-1', record.id))?.syncStatus).toBe('synced');
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('tasks: full pass, then a watermark pass applies a deleted tombstone', () => {
    const google = newFake();
    google.putTask('list-1', { due: '2026-08-30T00:00:00.000Z', id: 't1', title: 'Pay rent' });
    google.putTask('list-1', { due: '2026-08-31T00:00:00.000Z', id: 't2', title: 'Call mum' });
    return Effect.gen(function* () {
      yield* seedAccount(true);
      const engine = yield* SyncEngine;
      const repo = yield* TaskRepo;
      const ids = () =>
        Effect.map(repo.getWindow('2026-08-01', '2026-09-30'), (rows) =>
          rows.map((row) => row.id).sort(),
        );
      yield* engine.syncAll();
      expect(yield* ids()).toEqual(['t1', 't2']);

      google.now += 60_000;
      google.deleteTaskServerSide('list-1', 't2');
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect(yield* ids()).toEqual(['t1']);
      const listCalls = google.requests.filter(
        (call) => call.method === 'GET' && call.url.includes('/lists/list-1/tasks'),
      );
      expect(listCalls[0]!.url).not.toContain('updatedMin=');
      expect(listCalls[1]!.url).toContain('updatedMin=');
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('tasks: a local create takes the server-assigned id', () => {
    const google = newFake();
    return Effect.gen(function* () {
      yield* seedAccount(true);
      const engine = yield* SyncEngine;
      const mutations = yield* EventMutations;
      yield* engine.syncAll();
      const temp = yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: '2026-08-30',
        taskListId: 'list-1',
        title: 'From the app',
      });
      expect(temp.id.startsWith('local-')).toBe(true);
      yield* mutations.processPendingOps();
      const repo = yield* TaskRepo;
      const rows = yield* repo.getWindow('2026-08-01', '2026-09-30');
      expect(rows.map((row) => row.id)).toEqual(['task-1']);
      expect(google.taskOf('list-1', 'task-1')?.title).toBe('From the app');
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });
});
