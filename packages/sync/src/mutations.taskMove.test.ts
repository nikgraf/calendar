import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import {
  Account,
  APPLE_REMINDERS_ACCOUNT_ID,
  type MoveTaskParams,
  TaskListInfo,
  TaskRecord,
  Temporal,
} from '@calendar/core';
import { AccountRepo, PendingOpRepo, reposLayer, runMigrations, TaskRepo } from '@calendar/db';
import {
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GooglePeopleClient,
  type GooglePeopleClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
} from '@calendar/google';
import {
  makeFakeRemindersClient,
  RemindersClient,
  type RemindersClientShape,
  RemindersRequestError,
} from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer, Scheduler } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { EventMutations } from './mutations.ts';

// Queue assertions run before the detached drain gets a turn.
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

const inertCalendarClient: GoogleCalendarClientShape = {
  deleteEvent: () => Effect.void,
  getColors: () => Effect.succeed({ calendar: {} }),
  getEvent: () => Effect.die('unexpected get'),
  insertEvent: () => Effect.die('not used'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  moveEvent: () => Effect.die('unexpected move'),
  patchCalendarListEntry: () => Effect.die('not used'),
  patchEvent: () => Effect.die('not used'),
};

const inertPeopleClient: GooglePeopleClientShape = {
  listConnections: () => Effect.die('people not used in this test'),
  listOtherContacts: () => Effect.die('people not used in this test'),
};

/** Records what the drain pushes; nothing here is ever pulled. */
const recordingTasks = (calls: Array<string>): GoogleTasksClientShape => ({
  deleteTask: ({ taskId, taskListId }) =>
    Effect.sync(() => {
      calls.push(`delete ${taskListId}/${taskId}`);
    }),
  insertTask: ({ task, taskListId }) =>
    Effect.sync(() => {
      calls.push(`insert ${taskListId}/${task.title}`);
      return {
        id: `srv-${String(calls.length)}`,
        status: 'needsAction' as const,
        title: task.title,
        updated: '2030-01-01T00:00:00.000Z',
        ...(task.due === undefined ? {} : { due: task.due }),
        ...(task.notes === undefined ? {} : { notes: task.notes }),
      };
    }),
  listTaskLists: () => Effect.die('unexpected listTaskLists'),
  listTasks: () => Effect.die('unexpected listTasks'),
  patchTask: ({ changes, taskId }) =>
    Effect.sync(() => {
      calls.push(`patch ${taskId}/${String(changes.status)}`);
      return {
        id: taskId,
        status: changes.status ?? ('needsAction' as const),
        title: 'patched',
        updated: '2030-01-01T00:00:00.000Z',
      };
    }),
});

const testLayer = (reminders: RemindersClientShape, tasks: GoogleTasksClientShape) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, inertCalendarClient)),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, tasks)),
    Layer.provideMerge(Layer.succeed(GooglePeopleClient, inertPeopleClient)),
    Layer.provideMerge(Layer.succeed(RemindersClient, reminders)),
  );

// Date-independent: everything hangs off today.
const today = Temporal.Now.plainDateISO();
const tomorrow = today.add({ days: 1 }).toString();

const account = (id: string, provider: 'apple' | 'google') =>
  new Account({
    contactsEnabled: false,
    createdAt: 1,
    email: provider === 'google' ? `${id}@example.com` : '',
    id,
    provider,
    status: 'ok',
    tasksEnabled: true,
  });

const list = (accountId: string, id: string, provider: 'apple' | 'google') =>
  new TaskListInfo({ accountId, id, isVisible: true, provider, title: id });

const APPLE = APPLE_REMINDERS_ACCOUNT_ID;
const listA = { allowsModifications: true, colorHex: '#ff0000', id: 'list-a', title: 'list-a' };
const listB = { allowsModifications: true, colorHex: '#00ff00', id: 'list-b', title: 'list-b' };

const fakeWith = () =>
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
        url: 'https://example.com',
      },
      {
        alarms: [],
        completed: true,
        completedAt: 5,
        dueDate: tomorrow,
        id: 'rem-done',
        listId: 'list-a',
        priority: 0,
        title: 'Water plants',
        updatedAt: 10,
      },
    ],
  });

/** Two Google accounts with a list each (plus a second list on the first) and the mirrored reminders. */
const seed = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  const repo = yield* TaskRepo;
  for (const row of [
    account('acc-1', 'google'),
    account('acc-2', 'google'),
    account(APPLE, 'apple'),
  ]) {
    yield* accounts.upsert(row);
  }
  yield* repo.upsertLists(
    [
      list('acc-1', 'list-1', 'google'),
      list('acc-1', 'list-2', 'google'),
      list('acc-2', 'list-x', 'google'),
      list(APPLE, 'list-a', 'apple'),
      list(APPLE, 'list-b', 'apple'),
    ],
    100,
  );
  yield* repo.upsertTasks(
    [
      new TaskRecord({
        accountId: 'acc-1',
        dueDate: tomorrow,
        id: 't1',
        listId: 'list-1',
        notes: 'transfer first',
        provider: 'google',
        status: 'needsAction',
        title: 'Pay rent',
        updatedAt: 100,
        webViewLink: 'https://tasks.google.com/t1',
      }),
      new TaskRecord({
        accountId: APPLE,
        alarms: [-15],
        dueDate: tomorrow,
        dueTime: '09:00',
        id: 'rem-timed',
        listId: 'list-a',
        priority: 'high',
        provider: 'apple',
        status: 'needsAction',
        title: 'Call mom',
        updatedAt: 100,
        url: 'https://example.com',
      }),
      new TaskRecord({
        accountId: APPLE,
        completedAt: 5,
        dueDate: tomorrow,
        id: 'rem-done',
        listId: 'list-a',
        provider: 'apple',
        status: 'completed',
        title: 'Water plants',
        updatedAt: 100,
      }),
    ],
    100,
  );
});

const rowAt = (accountId: string, listId: string, taskId: string) =>
  Effect.flatMap(TaskRepo, (repo) => repo.get(accountId, listId, taskId));

const queued = Effect.map(
  Effect.flatMap(PendingOpRepo, (ops) => ops.listAll()),
  (ops) => ops.map((op) => `${op.kind} ${op.accountId}/${op.calendarId}/${op.eventId}`),
);

const move = (
  [accountId, taskListId, taskId]: [string, string, string],
  [targetAccountId, targetListId]: [string, string],
  draft: MoveTaskParams['draft'],
) =>
  Effect.flatMap(EventMutations, (mutations) =>
    mutations.moveTask({
      accountId,
      draft,
      target: { accountId: targetAccountId, taskListId: targetListId },
      taskId,
      taskListId,
    }),
  );

describe('moveTask across providers', () => {
  it.effect(
    'Apple → Google queues a create with what Google holds and removes the reminder',
    () => {
      const fake = fakeWith();
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        yield* seed;
        const created = yield* move([APPLE, 'list-a', 'rem-timed'], ['acc-1', 'list-1'], {
          dueDate: tomorrow,
          notes: 'from Reminders',
          title: 'Call mom',
        });
        expect(created).toMatchObject({
          accountId: 'acc-1',
          listId: 'list-1',
          notes: 'from Reminders',
          provider: 'google',
          status: 'needsAction',
          title: 'Call mom',
        });
        expect(created.id.startsWith('local-')).toBe(true);
        expect(created.dueTime).toBeUndefined();
        expect(fake.state.reminders.has('rem-timed')).toBe(false);
        expect(yield* rowAt(APPLE, 'list-a', 'rem-timed')).toBeUndefined();
        expect((yield* rowAt('acc-1', 'list-1', created.id))?.title).toBe('Call mom');
        expect(yield* queued).toEqual([`createTask acc-1/list-1/${created.id}`]);
        // The push swaps the temp id for the server's.
        yield* (yield* EventMutations).processPendingOps();
        expect(calls).toEqual(['insert list-1/Call mom']);
        expect(yield* queued).toEqual([]);
        expect(yield* rowAt('acc-1', 'list-1', created.id)).toBeUndefined();
        expect((yield* rowAt('acc-1', 'list-1', 'srv-1'))?.title).toBe('Call mom');
      }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks(calls))));
    },
  );

  it.effect('Apple → Google keeps a completed reminder completed', () => {
    const fake = fakeWith();
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      yield* seed;
      const created = yield* move([APPLE, 'list-a', 'rem-done'], ['acc-1', 'list-1'], {
        dueDate: tomorrow,
        title: 'Water plants',
      });
      expect(created.status).toBe('completed');
      expect((yield* rowAt('acc-1', 'list-1', created.id))?.status).toBe('completed');
      expect(yield* queued).toEqual([
        `createTask acc-1/list-1/${created.id}`,
        `completeTask acc-1/list-1/${created.id}`,
      ]);
      yield* (yield* EventMutations).processPendingOps();
      expect(calls).toEqual(['insert list-1/Water plants', 'patch srv-1/completed']);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks(calls))));
  });

  it.effect('Apple → Google refuses Reminders-only draft fields and changes nothing', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      const error = yield* Effect.flip(
        move([APPLE, 'list-a', 'rem-timed'], ['acc-1', 'list-1'], {
          dueDate: tomorrow,
          dueTime: '09:00',
          title: 'Call mom',
        }),
      );
      expect(error._tag).toBe('UnsupportedForProviderError');
      expect(fake.state.reminders.has('rem-timed')).toBe(true);
      expect(yield* rowAt(APPLE, 'list-a', 'rem-timed')).toBeDefined();
      expect(yield* queued).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect(
    'Google → Apple writes the draft to EventKit (time and priority included) and queues the delete',
    () => {
      const fake = fakeWith();
      return Effect.gen(function* () {
        yield* seed;
        const created = yield* move(['acc-1', 'list-1', 't1'], [APPLE, 'list-b'], {
          alarms: [-30],
          dueDate: tomorrow,
          dueTime: '18:00',
          notes: 'transfer first',
          priority: 'high',
          title: 'Pay rent',
        });
        expect(created).toMatchObject({
          accountId: APPLE,
          alarms: [-30],
          dueTime: '18:00',
          listId: 'list-b',
          priority: 'high',
          provider: 'apple',
          title: 'Pay rent',
        });
        expect(created.webViewLink).toBeUndefined();
        expect(fake.state.reminders.get(created.id)).toMatchObject({
          dueTime: '18:00',
          listId: 'list-b',
          priority: 1,
        });
        expect(yield* rowAt('acc-1', 'list-1', 't1')).toBeUndefined();
        expect((yield* rowAt(APPLE, 'list-b', created.id))?.title).toBe('Pay rent');
        expect(yield* queued).toEqual(['deleteTask acc-1/list-1/t1']);
      }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
    },
  );

  it.effect('Google → Apple of an unpushed create sends nothing to Google', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const local = yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: tomorrow,
        taskListId: 'list-1',
        title: 'Not yet pushed',
      });
      expect(yield* queued).toEqual([`createTask acc-1/list-1/${local.id}`]);
      const created = yield* move(['acc-1', 'list-1', local.id], [APPLE, 'list-a'], {
        dueDate: tomorrow,
        title: 'Not yet pushed',
      });
      expect(fake.state.reminders.get(created.id)?.title).toBe('Not yet pushed');
      expect(yield* rowAt('acc-1', 'list-1', local.id)).toBeUndefined();
      expect(yield* queued).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect(
    'Google → Google (another list, another account) copies and deletes through the queue',
    () => {
      const fake = fakeWith();
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        yield* seed;
        const inList2 = yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
          dueDate: tomorrow,
          notes: 'transfer first',
          title: 'Pay rent',
        });
        expect(inList2).toMatchObject({ accountId: 'acc-1', listId: 'list-2', provider: 'google' });
        expect(yield* rowAt('acc-1', 'list-1', 't1')).toBeUndefined();
        expect(yield* queued).toEqual([
          `createTask acc-1/list-2/${inList2.id}`,
          'deleteTask acc-1/list-1/t1',
        ]);
        yield* (yield* EventMutations).processPendingOps();
        expect(calls).toEqual(['insert list-2/Pay rent', 'delete list-1/t1']);
        const inAcc2 = yield* move(['acc-1', 'list-2', 'srv-1'], ['acc-2', 'list-x'], {
          dueDate: tomorrow,
          title: 'Pay rent',
        });
        expect(inAcc2).toMatchObject({ accountId: 'acc-2', listId: 'list-x' });
        expect(yield* rowAt('acc-1', 'list-2', 'srv-1')).toBeUndefined();
        expect(yield* queued).toEqual([
          `createTask acc-2/list-x/${inAcc2.id}`,
          'deleteTask acc-1/list-2/srv-1',
        ]);
      }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks(calls))));
    },
  );

  it.effect('Apple → Apple re-homes the reminder in place and keeps its identifier', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      const moved = yield* move([APPLE, 'list-a', 'rem-timed'], [APPLE, 'list-b'], {
        alarms: [-15],
        dueDate: tomorrow,
        dueTime: '10:30',
        priority: 'high',
        title: 'Call mum',
        url: 'https://example.com',
      });
      expect(moved).toMatchObject({ dueTime: '10:30', id: 'rem-timed', listId: 'list-b' });
      expect(fake.state.reminders.get('rem-timed')).toMatchObject({
        dueTime: '10:30',
        listId: 'list-b',
        title: 'Call mum',
      });
      expect(yield* rowAt(APPLE, 'list-a', 'rem-timed')).toBeUndefined();
      expect(yield* queued).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect('a move to the same list is a no-op', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      const same = yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-1'], {
        dueDate: tomorrow,
        title: 'Renamed in the draft',
      });
      expect(same.title).toBe('Pay rent');
      expect(yield* queued).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect('refuses an unknown target list and a missing source', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      const noList = yield* Effect.flip(
        move([APPLE, 'list-a', 'rem-timed'], ['acc-1', 'nope'], { dueDate: tomorrow, title: 'x' }),
      );
      expect(noList._tag).toBe('TaskListNotFoundError');
      expect(fake.state.reminders.has('rem-timed')).toBe(true);
      const noTask = yield* Effect.flip(
        move(['acc-1', 'list-1', 'ghost'], [APPLE, 'list-a'], { dueDate: tomorrow, title: 'x' }),
      );
      expect(noTask._tag).toBe('TaskNotFoundError');
      expect(yield* queued).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect('a delete that fails after the copy leaves a duplicate, never a lost task', () => {
    const fake = fakeWith();
    const failingDelete: RemindersClientShape = {
      ...fake.client,
      delete: () =>
        Effect.fail(new RemindersRequestError({ message: 'EventKit refused', method: 'delete' })),
    };
    return Effect.gen(function* () {
      yield* seed;
      const error = yield* Effect.flip(
        move([APPLE, 'list-a', 'rem-timed'], ['acc-1', 'list-1'], {
          dueDate: tomorrow,
          title: 'Call mom',
        }),
      );
      expect(error._tag).toBe('RemindersRequestError');
      // The Google copy is queued and the reminder is still there.
      expect(yield* queued).toHaveLength(1);
      expect(fake.state.reminders.has('rem-timed')).toBe(true);
      expect(yield* rowAt(APPLE, 'list-a', 'rem-timed')).toBeDefined();
    }).pipe(noYield, Effect.provide(testLayer(failingDelete, recordingTasks([]))));
  });
});
