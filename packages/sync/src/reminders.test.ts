import { Account, APPLE_REMINDERS_ACCOUNT_ID, Temporal } from '@calendar/core';
import { AccountRepo, PendingOpRepo, reposLayer, runMigrations, TaskRepo } from '@calendar/db';
import {
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
} from '@calendar/google';
import { makeFakeRemindersClient, RemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import { SqlError, UnknownError } from 'effect/unstable/sql/SqlError';
import { describe } from 'vitest';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';

const inertCalendarClient: GoogleCalendarClientShape = {
  deleteEvent: () => Effect.void,
  getColors: () => Effect.succeed({ calendar: {} }),
  insertEvent: () => Effect.die('not used'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  patchCalendarListEntry: () => Effect.die('not used'),
  patchEvent: () => Effect.die('not used'),
};

/** Google Tasks must never be called for the Apple account. */
const inertTasksClient: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('unexpected deleteTask'),
  insertTask: () => Effect.die('unexpected insertTask'),
  listTaskLists: () => Effect.die('unexpected listTaskLists'),
  listTasks: () => Effect.die('unexpected listTasks'),
  patchTask: () => Effect.die('unexpected patchTask'),
};

const testLayer = (
  fake: ReturnType<typeof makeFakeRemindersClient>,
  overrides: Layer.Layer<never, never, TaskRepo> = Layer.empty,
) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(overrides),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, inertCalendarClient)),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, inertTasksClient)),
    Layer.provideMerge(Layer.succeed(RemindersClient, fake.client)),
  );

// Date-independent: everything hangs off today.
const today = Temporal.Now.plainDateISO();
const tomorrow = today.add({ days: 1 }).toString();
const farFuture = today.add({ years: 2 }).toString();
const longAgo = today.subtract({ years: 1 }).toString();

const appleAccount = new Account({
  createdAt: 1,
  displayName: 'Apple Reminders',
  email: '',
  id: APPLE_REMINDERS_ACCOUNT_ID,
  provider: 'apple',
  status: 'ok',
  tasksEnabled: true,
});

const seedApple = (account: Account = appleAccount) =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo;
    yield* accounts.upsert(account);
  });

const listA = { allowsModifications: true, colorHex: '#ff0000', id: 'list-a', title: 'Reminders' };
const listB = { allowsModifications: true, colorHex: '#00ff00', id: 'list-b', title: 'Groceries' };

const fakeWith = (overrides: Parameters<typeof makeFakeRemindersClient>[0] = {}) =>
  makeFakeRemindersClient({
    lists: [listA, listB],
    reminders: [
      {
        alarms: [-15],
        completed: false,
        dueDate: tomorrow,
        dueTime: '09:00',
        id: 'rem-timed',
        listId: 'list-a',
        priority: 1,
        title: 'Call mom',
        updatedAt: 10,
      },
      {
        alarms: [],
        completed: false,
        dueDate: tomorrow,
        id: 'rem-allday',
        listId: 'list-a',
        priority: 0,
        title: 'Water plants',
        updatedAt: 10,
      },
      {
        alarms: [],
        completed: false,
        dueDate: farFuture,
        id: 'rem-far',
        listId: 'list-b',
        priority: 0,
        title: 'Renew passport',
        updatedAt: 10,
      },
      {
        alarms: [],
        completed: true,
        completedAt: 5,
        dueDate: longAgo,
        id: 'rem-old-done',
        listId: 'list-b',
        priority: 0,
        title: 'Filed taxes',
        updatedAt: 10,
      },
      {
        alarms: [],
        completed: false,
        id: 'rem-undated',
        listId: 'list-a',
        priority: 0,
        title: 'Someday',
        updatedAt: 10,
      },
    ],
    ...overrides,
  });

const windowRows = Effect.gen(function* () {
  const taskRepo = yield* TaskRepo;
  return yield* taskRepo.getWindow(longAgo, farFuture);
});

describe('reminders sync', () => {
  it.effect('mirrors lists (with colors) and windowed reminders, timed first', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seedApple();
      const engine = yield* SyncEngine;
      yield* engine.syncAll();

      const lists = yield* (yield* TaskRepo).listLists(APPLE_REMINDERS_ACCOUNT_ID);
      expect(lists.map((list) => [list.title, list.provider, list.colorHex])).toEqual([
        ['Groceries', 'apple', '#00ff00'],
        ['Reminders', 'apple', '#ff0000'],
      ]);

      const rows = yield* windowRows;
      // Due-day order, timed first within a day; undated never appears.
      expect(rows.map((row) => row.id)).toEqual([
        'rem-old-done',
        'rem-timed',
        'rem-allday',
        'rem-far',
      ]);
      expect(rows[1]).toMatchObject({
        alarms: [-15],
        dueTime: '09:00',
        priority: 'high',
        provider: 'apple',
      });
      expect(rows[2]?.dueTime).toBeUndefined();
      expect(fake.state.calls).toContain('snapshot');
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('a second pass removes reminders that vanished from EventKit', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seedApple();
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      fake.state.reminders.delete('rem-allday');
      // Reconciliation only touches rows older than the pass (it.effect runs
      // on a TestClock, so time has to move on explicitly).
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      const rows = yield* windowRows;
      expect(rows.map((row) => row.id)).not.toContain('rem-allday');
      expect(rows.map((row) => row.id)).toContain('rem-timed');
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('a row mirrored during the pass survives; a stale unseen one is removed', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seedApple();
      const taskRepo = yield* TaskRepo;
      const stale = (id: string, syncedAt: number) =>
        taskRepo.upsertTasks(
          [
            {
              accountId: APPLE_REMINDERS_ACCOUNT_ID,
              dueDate: tomorrow,
              id,
              listId: 'list-a',
              provider: 'apple',
              status: 'needsAction',
              title: id,
              updatedAt: 1,
            },
          ],
          syncedAt,
        );
      // Mirrored long ago and no longer in EventKit → removed.
      yield* stale('gone', 1);
      // Mirrored "just now" (a concurrent create): newer than the pass → kept.
      yield* stale('fresh', Date.now() + 10_000);
      yield* TestClock.adjust('1 hour');
      yield* (yield* SyncEngine).syncAll();
      const ids = (yield* windowRows).map((row) => row.id);
      expect(ids).not.toContain('gone');
      expect(ids).toContain('fresh');
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('the mirror is complete: far-future, long-ago completed, and undated reminders', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seedApple();
      yield* (yield* SyncEngine).syncAll();
      const ids = (yield* windowRows).map((row) => row.id);
      // Two years out and completed a year ago both show on their due day.
      expect(ids).toContain('rem-far');
      expect(ids).toContain('rem-old-done');
      // Undated: mirrored (for the future list view) but not in a due window.
      expect(ids).not.toContain('rem-undated');
      const sql = yield* SqlClient;
      const undated = yield* sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM tasks WHERE id = 'rem-undated'`;
      expect(undated[0]?.n).toBe(1);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('a delta pass ships only rows changed since the last pass', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seedApple();
      const engine = yield* SyncEngine;
      // it.effect starts the TestClock at 0; the seeded updatedAt stamps (10)
      // must sit *before* the first pass's stamp for the delta to mean anything.
      yield* TestClock.adjust('1 hour');
      yield* engine.syncAll();
      yield* TestClock.adjust('1 hour');
      // The fake filters `changed` by updatedAt ≥ changedSince − 60 s, so a
      // reminder edited "now" (TestClock now) is in, the untouched ones out.
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      fake.state.reminders.set('rem-allday', {
        ...fake.state.reminders.get('rem-allday')!,
        title: 'Water the plants',
        updatedAt: now,
      });
      const before = fake.state.calls.filter((call) => call === 'snapshot').length;
      yield* engine.syncAll();
      expect(fake.state.calls.filter((call) => call === 'snapshot').length).toBe(before + 1);
      const rows = yield* windowRows;
      expect(rows.find((row) => row.id === 'rem-allday')?.title).toBe('Water the plants');
      expect(rows.find((row) => row.id === 'rem-timed')?.title).toBe('Call mom');
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('a snapshot id with no local row forces one full pass', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seedApple();
      const engine = yield* SyncEngine;
      // it.effect starts the TestClock at 0; the seeded updatedAt stamps (10)
      // must sit *before* the first pass's stamp for the delta to mean anything.
      yield* TestClock.adjust('1 hour');
      yield* engine.syncAll();
      yield* TestClock.adjust('1 hour');
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM tasks WHERE id = 'rem-timed'`;
      const before = fake.state.calls.filter((call) => call === 'snapshot').length;
      yield* engine.syncAll();
      // delta pass + the full repeat
      expect(fake.state.calls.filter((call) => call === 'snapshot').length).toBe(before + 2);
      expect((yield* windowRows).some((row) => row.id === 'rem-timed')).toBe(true);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('an unavailable bridge is skipped, never mistaken for a revoked grant', () => {
    const fake = fakeWith({ authorization: 'unavailable' });
    return Effect.gen(function* () {
      yield* seedApple();
      yield* (yield* SyncEngine).syncAll();
      expect((yield* (yield* AccountRepo).list())[0]?.status).toBe('ok');
      expect(fake.state.calls).not.toContain('listLists');
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('no access flags the account, restored access heals it without reconnecting', () => {
    const fake = fakeWith({ authorization: 'denied' });
    return Effect.gen(function* () {
      yield* seedApple();
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      const accounts = yield* AccountRepo;
      expect((yield* accounts.list())[0]?.status).toBe('reauth_required');
      expect(fake.state.calls).not.toContain('listLists');

      // The user re-allowed it in System Settings; the next pass notices.
      fake.state.authorization = 'fullAccess';
      yield* engine.syncAll();
      expect((yield* accounts.list())[0]?.status).toBe('ok');
      expect((yield* windowRows).length).toBe(4);
    }).pipe(Effect.provide(testLayer(fake)));
  });
});

describe('reminder mutations', () => {
  it.effect('createTask writes EventKit, mirrors the final row, and queues nothing', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seedApple();
      yield* (yield* SyncEngine).syncAll();
      const mutations = yield* EventMutations;
      const created = yield* mutations.createTask({
        accountId: APPLE_REMINDERS_ACCOUNT_ID,
        alarms: [-60],
        dueDate: tomorrow,
        dueTime: '14:30',
        priority: 'medium',
        recurrence: { freq: 'weekly', interval: 1 },
        taskListId: 'list-b',
        title: 'Buy milk',
        url: 'https://example.com',
      });
      // Real EventKit id, not a temp one.
      expect(created.id.startsWith('local-')).toBe(false);
      expect(fake.state.reminders.get(created.id)).toMatchObject({
        alarms: [-60],
        dueTime: '14:30',
        listId: 'list-b',
        priority: 5,
        recurrence: { freq: 'weekly', interval: 1 },
        title: 'Buy milk',
        url: 'https://example.com',
      });
      const row = (yield* windowRows).find((task) => task.id === created.id);
      expect(row).toMatchObject({
        priority: 'medium',
        provider: 'apple',
        url: 'https://example.com',
      });
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('a mirror write that fails after EventKit committed is not an error', () => {
    const fake = fakeWith();
    // The first upsert after setup fails (disk full, a lock): EventKit has
    // the reminder, so the mutation must still succeed — a raised error
    // would have the user press Save again and create a second one.
    let failNextUpsert = false;
    const flakyTaskRepo = Layer.effect(TaskRepo)(
      Effect.map(TaskRepo, (real) => ({
        ...real,
        upsertTasks: (tasks, syncedAt) => {
          if (failNextUpsert) {
            failNextUpsert = false;
            return Effect.fail(
              new SqlError({ reason: new UnknownError({ cause: new Error('SQLITE_FULL') }) }),
            );
          }
          return real.upsertTasks(tasks, syncedAt);
        },
      })),
    );
    return Effect.gen(function* () {
      yield* seedApple();
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      const mutations = yield* EventMutations;
      failNextUpsert = true;
      const created = yield* mutations.createTask({
        accountId: APPLE_REMINDERS_ACCOUNT_ID,
        dueDate: tomorrow,
        taskListId: 'list-b',
        title: 'Buy milk',
      });
      expect(fake.state.calls.filter((call) => call === 'create')).toHaveLength(1);
      expect(fake.state.reminders.get(created.id)?.title).toBe('Buy milk');
      // Not mirrored yet …
      expect((yield* windowRows).some((task) => task.id === created.id)).toBe(false);
      // … until the next pass (in production the change push runs it).
      yield* engine.syncAll();
      expect((yield* windowRows).some((task) => task.id === created.id)).toBe(true);
    }).pipe(Effect.provide(testLayer(fake, flakyTaskRepo)));
  });

  it.effect('updateTask can move between lists and clear reminder fields', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seedApple();
      yield* (yield* SyncEngine).syncAll();
      const mutations = yield* EventMutations;
      yield* mutations.updateTask({
        accountId: APPLE_REMINDERS_ACCOUNT_ID,
        changes: { dueTime: null, moveToListId: 'list-b', priority: null, title: 'Call mum' },
        taskId: 'rem-timed',
        taskListId: 'list-a',
      });
      expect(fake.state.reminders.get('rem-timed')).toMatchObject({
        listId: 'list-b',
        priority: 0,
        title: 'Call mum',
      });
      expect(fake.state.reminders.get('rem-timed')?.dueTime).toBeUndefined();
      const rows = yield* windowRows;
      const moved = rows.find((task) => task.id === 'rem-timed');
      expect(moved).toMatchObject({ listId: 'list-b', title: 'Call mum' });
      expect(moved?.priority).toBeUndefined();
      expect(moved?.dueTime).toBeUndefined();
      expect(rows.filter((task) => task.id === 'rem-timed').length).toBe(1);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('completeTask and deleteTask round-trip through EventKit', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seedApple();
      yield* (yield* SyncEngine).syncAll();
      const mutations = yield* EventMutations;
      yield* mutations.completeTask({
        accountId: APPLE_REMINDERS_ACCOUNT_ID,
        status: 'completed',
        taskId: 'rem-allday',
        taskListId: 'list-a',
      });
      expect(fake.state.reminders.get('rem-allday')?.completed).toBe(true);
      expect((yield* windowRows).find((task) => task.id === 'rem-allday')?.status).toBe(
        'completed',
      );

      yield* mutations.deleteTask({
        accountId: APPLE_REMINDERS_ACCOUNT_ID,
        taskId: 'rem-allday',
        taskListId: 'list-a',
      });
      expect(fake.state.reminders.has('rem-allday')).toBe(false);
      expect((yield* windowRows).some((task) => task.id === 'rem-allday')).toBe(false);
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect(
    'deleting a reminder that is already gone in EventKit still drops the mirror row',
    () => {
      const fake = fakeWith();
      return Effect.gen(function* () {
        yield* seedApple();
        yield* (yield* SyncEngine).syncAll();
        fake.state.reminders.delete('rem-allday');
        const mutations = yield* EventMutations;
        yield* mutations.deleteTask({
          accountId: APPLE_REMINDERS_ACCOUNT_ID,
          taskId: 'rem-allday',
          taskListId: 'list-a',
        });
        expect((yield* windowRows).some((task) => task.id === 'rem-allday')).toBe(false);
      }).pipe(Effect.provide(testLayer(fake)));
    },
  );

  it.effect('losing access mid-write flags the account', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seedApple();
      yield* (yield* SyncEngine).syncAll();
      fake.state.authorization = 'denied';
      const mutations = yield* EventMutations;
      const result = yield* Effect.result(
        mutations.deleteTask({
          accountId: APPLE_REMINDERS_ACCOUNT_ID,
          taskId: 'rem-allday',
          taskListId: 'list-a',
        }),
      );
      expect(result._tag).toBe('Failure');
      expect((yield* (yield* AccountRepo).list())[0]?.status).toBe('reauth_required');
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('a Google list rejects reminder-only fields and keeps the queue path', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      const accounts = yield* AccountRepo;
      yield* accounts.upsert(
        new Account({
          createdAt: 1,
          email: 'nik@nikgraf.com',
          id: 'acc-google',
          provider: 'google',
          status: 'ok',
          tasksEnabled: true,
        }),
      );
      const taskRepo = yield* TaskRepo;
      yield* taskRepo.upsertLists(
        [
          {
            accountId: 'acc-google',
            id: 'glist',
            isVisible: true,
            provider: 'google',
            title: 'My Tasks',
          },
        ],
        1,
      );
      const mutations = yield* EventMutations;
      const rejected = yield* Effect.result(
        mutations.createTask({
          accountId: 'acc-google',
          dueDate: tomorrow,
          priority: 'high',
          taskListId: 'glist',
          title: 'Nope',
        }),
      );
      expect(rejected._tag).toBe('Failure');
      if (rejected._tag === 'Failure') {
        expect(rejected.failure._tag).toBe('UnsupportedForProviderError');
      }
      // Plain fields still take the optimistic temp-id + queued-op route.
      const created = yield* mutations.createTask({
        accountId: 'acc-google',
        dueDate: tomorrow,
        taskListId: 'glist',
        title: 'Pay rent',
      });
      expect(created.id.startsWith('local-')).toBe(true);
      // EventKit was never involved for the Google list.
      expect(fake.state.calls).not.toContain('create');
    }).pipe(Effect.provide(testLayer(fake)));
  });
});

describe('reminders change push', () => {
  it.effect('a change notification runs a reminders pass without waiting for the schedule', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seedApple();
      const engine = yield* SyncEngine;
      yield* TestClock.adjust('1 hour');
      yield* engine.start();
      yield* TestClock.adjust('1 millis');
      const afterStart = fake.state.calls.filter((call) => call === 'snapshot').length;
      expect(afterStart).toBe(1);
      // A burst (iCloud sync, our own write-throughs) collapses into one pass.
      fake.state.emitChange();
      fake.state.emitChange();
      fake.state.emitChange();
      yield* TestClock.adjust('1 second');
      yield* TestClock.adjust('1 millis');
      expect(fake.state.calls.filter((call) => call === 'snapshot').length).toBe(afterStart + 1);
      // Quiet: nothing runs until the 90 s schedule.
      yield* TestClock.adjust('10 seconds');
      expect(fake.state.calls.filter((call) => call === 'snapshot').length).toBe(afterStart + 1);
    }).pipe(Effect.provide(testLayer(fake)));
  });
});
