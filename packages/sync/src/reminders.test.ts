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

const testLayer = (fake: ReturnType<typeof makeFakeRemindersClient>) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
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
    ],
    ...overrides,
  });

const windowRows = Effect.gen(function* () {
  const taskRepo = yield* TaskRepo;
  return yield* taskRepo.getWindow(today.subtract({ days: 1 }).toString(), farFuture);
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
      // The far-future reminder is outside the mirror window.
      expect(rows.map((row) => row.id)).toEqual(['rem-timed', 'rem-allday']);
      expect(rows[0]).toMatchObject({
        alarms: [-15],
        dueTime: '09:00',
        priority: 'high',
        provider: 'apple',
      });
      expect(rows[1]?.dueTime).toBeUndefined();
      // Google Tasks was never consulted for the Apple account.
      expect(fake.state.calls).toContain('list');
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
      expect(rows.map((row) => row.id)).toEqual(['rem-timed']);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect(
    'a row mirrored during the pass, or due outside the window, survives reconciliation',
    () => {
      const fake = fakeWith();
      return Effect.gen(function* () {
        yield* seedApple();
        const taskRepo = yield* TaskRepo;
        const stale = (id: string, dueDate: string, syncedAt: number) =>
          taskRepo.upsertTasks(
            [
              {
                accountId: APPLE_REMINDERS_ACCOUNT_ID,
                dueDate,
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
        yield* stale('gone', tomorrow, 1);
        // Mirrored "just now" (a concurrent create): newer than the pass → kept.
        yield* stale('fresh', tomorrow, Date.now() + 10_000);
        // Outside the fetched window: not this pass's business → kept.
        yield* stale('far', farFuture, 1);
        yield* TestClock.adjust('1 hour');
        yield* (yield* SyncEngine).syncAll();
        const ids = (yield* windowRows).map((row) => row.id);
        expect(ids).not.toContain('gone');
        expect(ids).toContain('fresh');
        expect(ids).toContain('far');
      }).pipe(Effect.provide(testLayer(fake)));
    },
  );

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
      expect((yield* windowRows).length).toBe(2);
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
