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
  ApiUnavailableError,
  type GcalTask,
  type GoogleTasksClientShape,
  NotFoundError,
} from '@calendar/google';
import {
  makeFakeRemindersClient,
  RemindersClient,
  type RemindersClientShape,
  RemindersRequestError,
} from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Scheduler } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { EventMutations } from './mutations.ts';

// Queue assertions run before the detached drain gets a turn.
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

const inertCalendarClient: GoogleCalendarClientShape = {
  deleteEvent: () => Effect.void,
  getColors: () => Effect.succeed({ calendar: {} }),
  getEvent: () => Effect.die('unexpected get'),
  insertCalendar: () => Effect.die('not used'),
  insertEvent: () => Effect.die('not used'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  moveEvent: () => Effect.die('unexpected move'),
  patchCalendarListEntry: () => Effect.die('not used'),
  patchEvent: () => Effect.die('not used'),
  replaceEvent: () => Effect.die('not used'),
};

const inertPeopleClient: GooglePeopleClientShape = {
  listConnections: () => Effect.die('people not used in this test'),
  listOtherContacts: () => Effect.die('people not used in this test'),
};

/** Records what the drain pushes and answers like Google; nothing here is ever pulled. */
const recordingTasks = (calls: Array<string>): GoogleTasksClientShape => {
  const stored = new Map<string, GcalTask>();
  return {
    deleteTask: ({ taskId, taskListId }) =>
      Effect.sync(() => {
        calls.push(`delete ${taskListId}/${taskId}`);
      }),
    insertTask: ({ parent, task, taskListId }) =>
      Effect.sync(() => {
        calls.push(
          `insert ${taskListId}/${task.title}${parent === undefined ? '' : ` under ${parent}`}`,
        );
        const created: GcalTask = {
          id: `srv-${String(calls.length)}`,
          status: 'needsAction' as const,
          title: task.title,
          updated: '2030-01-01T00:00:00.000Z',
          ...(task.due === undefined ? {} : { due: task.due }),
          ...(task.notes === undefined ? {} : { notes: task.notes }),
          ...(parent === undefined ? {} : { parent }),
        };
        stored.set(created.id, created);
        return created;
      }),
    listTaskLists: () => Effect.die('unexpected listTaskLists'),
    listTasks: () => Effect.die('unexpected listTasks'),
    moveTask: ({ destinationTaskListId, taskId, taskListId }) =>
      Effect.sync(() => {
        calls.push(`move ${taskListId}/${taskId} -> ${destinationTaskListId}`);
        return {
          id: taskId,
          status: 'needsAction' as const,
          title: 'moved',
          updated: '2030-01-01T00:00:00.000Z',
        };
      }),
    patchTask: ({ changes, taskId }) =>
      Effect.sync(() => {
        calls.push(`patch ${taskId}/${String(changes.status)}`);
        const base = stored.get(taskId) ?? {
          id: taskId,
          status: 'needsAction' as const,
          title: 'patched',
          updated: '2030-01-01T00:00:00.000Z',
        };
        return { ...base, status: changes.status ?? base.status };
      }),
  };
};

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

/** Two subtasks of `t1`, the second done. */
const withSubtasks = Effect.flatMap(TaskRepo, (repo) =>
  repo.upsertTasks(
    [
      new TaskRecord({
        accountId: 'acc-1',
        id: 's1',
        listId: 'list-1',
        parentId: 't1',
        position: '00000000000000000000',
        provider: 'google',
        status: 'needsAction',
        title: 'First step',
        updatedAt: 100,
      }),
      new TaskRecord({
        accountId: 'acc-1',
        completedAt: 50,
        id: 's2',
        listId: 'list-1',
        parentId: 't1',
        position: '00000000000000000001',
        provider: 'google',
        status: 'completed',
        title: 'Second step',
        updatedAt: 100,
      }),
    ],
    100,
  ),
);

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
    'Google → Google inside one account moves on Google: the id stays, the edits go first, the subtasks come along',
    () => {
      const fake = fakeWith();
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        yield* seed;
        yield* withSubtasks;
        const moved = yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
          dueDate: tomorrow,
          notes: 'transfer first',
          title: 'Pay the rent',
        });
        expect(moved).toMatchObject({ id: 't1', listId: 'list-2', title: 'Pay the rent' });
        for (const id of ['t1', 's1', 's2']) {
          expect(yield* rowAt('acc-1', 'list-1', id)).toBeUndefined();
        }
        // The task left no parent behind; its subtasks keep theirs.
        expect((yield* rowAt('acc-1', 'list-2', 't1'))?.parentId).toBeUndefined();
        expect((yield* rowAt('acc-1', 'list-2', 's1'))?.parentId).toBe('t1');
        expect((yield* rowAt('acc-1', 'list-2', 's2'))?.parentId).toBe('t1');
        // The rename was queued first, in the source list; it follows the move.
        expect(yield* queued).toEqual(['moveTask acc-1/list-1/t1', 'updateTask acc-1/list-2/t1']);
        yield* (yield* EventMutations).processPendingOps();
        expect(calls).toEqual(['move list-1/t1 -> list-2', 'patch t1/undefined']);
        expect(yield* queued).toEqual([]);
      }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks(calls))));
    },
  );

  it.effect(
    'Google → Google across accounts copies the task and its subtasks, nested and in order, then deletes them',
    () => {
      const fake = fakeWith();
      const calls: Array<string> = [];
      return Effect.gen(function* () {
        yield* seed;
        yield* withSubtasks;
        const copied = yield* move(['acc-1', 'list-1', 't1'], ['acc-2', 'list-x'], {
          dueDate: tomorrow,
          title: 'Pay rent',
        });
        expect(copied).toMatchObject({ accountId: 'acc-2', listId: 'list-x' });
        expect(yield* rowAt('acc-1', 'list-1', 't1')).toBeUndefined();
        expect(yield* rowAt('acc-1', 'list-1', 's1')).toBeUndefined();
        yield* (yield* EventMutations).processPendingOps();
        // Google puts a new subtask first among its siblings: last one in first.
        expect(calls).toEqual([
          'insert list-x/Pay rent',
          'insert list-x/Second step under srv-1',
          'patch srv-2/completed',
          'insert list-x/First step under srv-1',
          'delete list-1/s1',
          'delete list-1/s2',
          'delete list-1/t1',
        ]);
        const copies = (yield* (yield* TaskRepo).getMirrorSource('acc-2', ['list-x'])).map(
          (task) => [task.title, task.parentId ?? null, task.status],
        );
        expect(copies).toEqual(
          expect.arrayContaining([
            ['Pay rent', null, 'needsAction'],
            ['First step', 'srv-1', 'needsAction'],
            ['Second step', 'srv-1', 'completed'],
          ]),
        );
      }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks(calls))));
    },
  );

  it.effect('Google → Apple brings the subtasks along as reminders of their own', () => {
    const fake = fakeWith();
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      yield* move(['acc-1', 'list-1', 't1'], [APPLE, 'list-b'], {
        dueDate: tomorrow,
        title: 'Pay rent',
      });
      const inB = [...fake.state.reminders.values()].filter((entry) => entry.listId === 'list-b');
      expect(inB.map((entry) => [entry.title, entry.completed]).sort()).toEqual([
        ['First step', false],
        ['Pay rent', false],
        ['Second step', true],
      ]);
      // Subtasks first: Google would otherwise delete them with their parent.
      expect(yield* queued).toEqual([
        'deleteTask acc-1/list-1/s1',
        'deleteTask acc-1/list-1/s2',
        'deleteTask acc-1/list-1/t1',
      ]);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks(calls))));
  });

  it.effect(
    'the preview names a subtask leaving its parent and subtasks Reminders flattens',
    () => {
      const fake = fakeWith();
      return Effect.gen(function* () {
        yield* seed;
        yield* withSubtasks;
        const mutations = yield* EventMutations;
        const preview = (taskId: string, target: [string, string]) =>
          mutations.previewMoveTask({
            accountId: 'acc-1',
            target: { accountId: target[0], taskListId: target[1] },
            taskId,
            taskListId: 'list-1',
          });
        expect(yield* preview('t1', [APPLE, 'list-b'])).toMatchObject({
          leavesParent: false,
          subtasksUnnested: 2,
        });
        expect(yield* preview('t1', ['acc-1', 'list-2'])).toMatchObject({
          leavesParent: false,
          subtasksUnnested: 0,
        });
        expect(yield* preview('s1', ['acc-1', 'list-2'])).toMatchObject({
          leavesParent: true,
          subtasksUnnested: 0,
        });
      }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
    },
  );

  it.effect('a subtask moved inside one account becomes a task of its own there', () => {
    const fake = fakeWith();
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      yield* move(['acc-1', 'list-1', 's1'], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        title: 'First step',
      });
      expect((yield* rowAt('acc-1', 'list-2', 's1'))?.parentId).toBeUndefined();
      // Its parent and sibling stay.
      expect(yield* rowAt('acc-1', 'list-1', 't1')).toBeDefined();
      expect(yield* rowAt('acc-1', 'list-1', 's2')).toBeDefined();
      // The form gave it a due day: that edit follows the move.
      expect(yield* queued).toEqual(['moveTask acc-1/list-1/s1', 'updateTask acc-1/list-2/s1']);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks(calls))));
  });

  it.effect('a task whose create never went out moves without a server move', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const local = yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: tomorrow,
        taskListId: 'list-1',
        title: 'Fresh',
      });
      yield* move(['acc-1', 'list-1', local.id], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        title: 'Fresh',
      });
      expect(yield* rowAt('acc-1', 'list-2', local.id)).toBeDefined();
      expect(yield* queued).toEqual([`createTask acc-1/list-2/${local.id}`]);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect('refuses to move a task whose create went out and has not been answered', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const local = yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: tomorrow,
        taskListId: 'list-1',
        title: 'In flight',
      });
      const ops = yield* PendingOpRepo;
      const [create] = yield* ops.listAll();
      yield* ops.markDispatched(create!.id, 1);
      const error = yield* Effect.flip(
        move(['acc-1', 'list-1', local.id], ['acc-1', 'list-2'], {
          dueDate: tomorrow,
          title: 'In flight',
        }),
      );
      expect(error._tag).toBe('TaskCreatePendingError');
      expect(yield* rowAt('acc-1', 'list-1', local.id)).toBeDefined();
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect('a move Google answers 404 puts the task and its subtasks back in the source', () => {
    const fake = fakeWith();
    const gone: GoogleTasksClientShape = {
      ...recordingTasks([]),
      // Nor is it in the destination: the move never happened.
      listTasks: () => Effect.succeed({ items: [] }),
      moveTask: () => Effect.fail(new NotFoundError({ resource: 'task t1' })),
    };
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        notes: 'transfer first',
        title: 'Pay rent',
      });
      yield* (yield* EventMutations).processPendingOps();
      expect(yield* queued).toEqual([]);
      expect((yield* rowAt('acc-1', 'list-1', 't1'))?.parentId).toBeUndefined();
      expect((yield* rowAt('acc-1', 'list-1', 's1'))?.parentId).toBe('t1');
      expect(yield* rowAt('acc-1', 'list-2', 't1')).toBeUndefined();
      expect(yield* rowAt('acc-1', 'list-2', 's2')).toBeUndefined();
    }).pipe(noYield, Effect.provide(testLayer(fake.client, gone)));
  });

  it.effect(
    'an edit queued into the destination waits for the move, even after a failed attempt',
    () => {
      const fake = fakeWith();
      const calls: Array<string> = [];
      const flaky: GoogleTasksClientShape = {
        ...recordingTasks(calls),
        moveTask: () => Effect.fail(new ApiUnavailableError({ cause: 'try later' })),
      };
      return Effect.gen(function* () {
        yield* seed;
        yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
          dueDate: tomorrow,
          notes: 'transfer first',
          title: 'Pay the rent',
        });
        const mutations = yield* EventMutations;
        yield* mutations.processPendingOps();
        // The move backs off; the rename behind it must not patch a list
        // Google has no such task in yet.
        yield* TestClock.adjust('1 hour');
        yield* mutations.processPendingOps();
        expect(calls).toEqual([]);
        expect(yield* queued).toEqual(['moveTask acc-1/list-1/t1', 'updateTask acc-1/list-2/t1']);
        expect(yield* rowAt('acc-1', 'list-2', 't1')).toBeDefined();
      }).pipe(noYield, Effect.provide(testLayer(fake.client, flaky)));
    },
  );

  it.effect('discarding a queued move puts the task and its subtasks back', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        notes: 'transfer first',
        title: 'Pay rent',
      });
      const [moveOp] = yield* (yield* PendingOpRepo).listAll();
      expect(moveOp?.kind).toBe('moveTask');
      yield* (yield* EventMutations).discardPendingOp(moveOp!.id);
      expect(yield* queued).toEqual([]);
      for (const id of ['t1', 's1', 's2']) {
        expect(yield* rowAt('acc-1', 'list-1', id)).toBeDefined();
        expect(yield* rowAt('acc-1', 'list-2', id)).toBeUndefined();
      }
      expect((yield* rowAt('acc-1', 'list-1', 's2'))?.parentId).toBe('t1');
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect('a 404 after a move that landed unanswered settles it in the destination', () => {
    const fake = fakeWith();
    const landed: GoogleTasksClientShape = {
      ...recordingTasks([]),
      listTasks: ({ taskListId }) =>
        Effect.succeed({
          items:
            taskListId === 'list-2'
              ? [
                  {
                    id: 't1',
                    status: 'needsAction',
                    title: 'Pay rent',
                    updated: '2030-01-01T00:00:00.000Z',
                  },
                ]
              : [],
        }),
      moveTask: () => Effect.fail(new NotFoundError({ resource: 'task t1' })),
    };
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        notes: 'transfer first',
        title: 'Pay rent',
      });
      yield* (yield* EventMutations).processPendingOps();
      expect(yield* queued).toEqual([]);
      for (const id of ['t1', 's1', 's2']) {
        expect(yield* rowAt('acc-1', 'list-2', id)).toBeDefined();
        expect(yield* rowAt('acc-1', 'list-1', id)).toBeUndefined();
      }
    }).pipe(noYield, Effect.provide(testLayer(fake.client, landed)));
  });

  it.effect('a second move waits behind the first, and a discard sends what followed back', () => {
    const fake = fakeWith();
    const calls: Array<string> = [];
    const flaky: GoogleTasksClientShape = {
      ...recordingTasks(calls),
      moveTask: () => Effect.fail(new ApiUnavailableError({ cause: 'try later' })),
    };
    return Effect.gen(function* () {
      yield* seed;
      yield* (yield* TaskRepo).upsertLists([list('acc-1', 'list-3', 'google')], 100);
      const draft = { dueDate: tomorrow, notes: 'transfer first', title: 'Pay the rent' };
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], draft);
      // Onwards before the first move landed.
      yield* move(['acc-1', 'list-2', 't1'], ['acc-1', 'list-3'], draft);
      const mutations = yield* EventMutations;
      yield* mutations.processPendingOps();
      // Only the first move was tried; the second and the rename wait.
      expect(calls).toEqual([]);
      expect(yield* queued).toEqual([
        'moveTask acc-1/list-1/t1',
        'moveTask acc-1/list-2/t1',
        'updateTask acc-1/list-3/t1',
      ]);
      // Discarding the first sends the second back to the source: 1 → 3.
      const [first] = yield* (yield* PendingOpRepo).listAll();
      yield* mutations.discardPendingOp(first!.id);
      expect(yield* queued).toEqual(['moveTask acc-1/list-1/t1', 'updateTask acc-1/list-3/t1']);
      const [onwards] = yield* (yield* PendingOpRepo).listAll();
      expect(onwards?.targetTaskListId).toBe('list-3');
      expect(yield* rowAt('acc-1', 'list-3', 't1')).toBeDefined();
    }).pipe(noYield, Effect.provide(testLayer(fake.client, flaky)));
  });

  it.effect('a pulled copy left in the source while the move waited goes when it lands', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        notes: 'transfer first',
        title: 'Pay rent',
      });
      yield* (yield* TaskRepo).upsertTasks(
        [
          new TaskRecord({
            accountId: 'acc-1',
            id: 's1',
            listId: 'list-1',
            parentId: 't1',
            provider: 'google',
            status: 'needsAction',
            title: 'First step',
            updatedAt: 200,
          }),
        ],
        200,
        { mode: 'pull' },
      );
      yield* (yield* EventMutations).processPendingOps();
      expect(yield* rowAt('acc-1', 'list-1', 's1')).toBeUndefined();
      expect(yield* rowAt('acc-1', 'list-2', 's1')).toBeDefined();
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect('an unsent subtask copy moved on its own nests under nothing there', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      yield* (yield* TaskRepo).upsertLists([list('acc-2', 'list-y', 'google')], 100);
      yield* move(['acc-1', 'list-1', 't1'], ['acc-2', 'list-x'], {
        dueDate: tomorrow,
        title: 'Pay rent',
      });
      const [copy] = (yield* (yield* TaskRepo).getMirrorSource('acc-2', ['list-x'])).filter(
        (task) => task.title === 'First step',
      );
      yield* move(['acc-2', 'list-x', copy!.id], ['acc-2', 'list-y'], {
        dueDate: tomorrow,
        title: 'First step',
      });
      const create = (yield* (yield* PendingOpRepo).listAll()).find(
        (op) => op.kind === 'createTask' && op.eventId === copy!.id,
      );
      expect(create).toMatchObject({ calendarId: 'list-y' });
      expect(create?.taskParent).toBeUndefined();
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect('a parent create that is discarded takes the subtask creates waiting on it', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      const copied = yield* move(['acc-1', 'list-1', 't1'], ['acc-2', 'list-x'], {
        dueDate: tomorrow,
        title: 'Pay rent',
      });
      const parentCreate = (yield* (yield* PendingOpRepo).listAll()).find(
        (op) => op.kind === 'createTask' && op.eventId === copied.id,
      );
      yield* (yield* EventMutations).discardPendingOp(parentCreate!.id);
      expect(yield* (yield* TaskRepo).getMirrorSource('acc-2', ['list-x'])).toEqual([]);
      expect((yield* queued).filter((entry) => entry.includes('acc-2/'))).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect('a task that comes back to a list and moves on keeps every move in order', () => {
    const fake = fakeWith();
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      yield* seed;
      yield* (yield* TaskRepo).upsertLists([list('acc-1', 'list-3', 'google')], 100);
      const draft = { dueDate: tomorrow, notes: 'transfer first', title: 'Pay rent' };
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], draft);
      yield* move(['acc-1', 'list-2', 't1'], ['acc-1', 'list-1'], draft);
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-3'], draft);
      yield* (yield* EventMutations).processPendingOps();
      expect(calls).toEqual([
        'move list-1/t1 -> list-2',
        'move list-2/t1 -> list-1',
        'move list-1/t1 -> list-3',
      ]);
      expect(yield* rowAt('acc-1', 'list-3', 't1')).toBeDefined();
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks(calls))));
  });

  it.effect('a discarded move takes back the delete of a subtask removed after it', () => {
    const fake = fakeWith();
    const flaky: GoogleTasksClientShape = {
      ...recordingTasks([]),
      moveTask: () => Effect.fail(new ApiUnavailableError({ cause: 'try later' })),
    };
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        notes: 'transfer first',
        title: 'Pay rent',
      });
      const mutations = yield* EventMutations;
      yield* mutations.deleteTask({ accountId: 'acc-1', taskId: 's1', taskListId: 'list-2' });
      const [moveOp] = yield* (yield* PendingOpRepo).listAll();
      yield* mutations.discardPendingOp(moveOp!.id);
      expect(yield* queued).toEqual(['deleteTask acc-1/list-1/s1']);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, flaky)));
  });

  it.effect('a 404 whose destination cannot be checked keeps the move queued', () => {
    const fake = fakeWith();
    const unsure: GoogleTasksClientShape = {
      ...recordingTasks([]),
      listTasks: () => Effect.fail(new ApiUnavailableError({ cause: 'try later' })),
      moveTask: () => Effect.fail(new NotFoundError({ resource: 'task t1' })),
    };
    return Effect.gen(function* () {
      yield* seed;
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        notes: 'transfer first',
        title: 'Pay rent',
      });
      yield* (yield* EventMutations).processPendingOps();
      expect(yield* queued).toEqual(['moveTask acc-1/list-1/t1']);
      expect(yield* rowAt('acc-1', 'list-2', 't1')).toBeDefined();
    }).pipe(noYield, Effect.provide(testLayer(fake.client, unsure)));
  });

  it.effect('a landed move is found on a later page of the destination', () => {
    const fake = fakeWith();
    const paged: GoogleTasksClientShape = {
      ...recordingTasks([]),
      listTasks: ({ params }) =>
        Effect.succeed(
          params.pageToken === undefined
            ? { items: [{ id: 'other', title: 'Other' }], nextPageToken: 'p2' }
            : { items: [{ id: 't1', status: 'needsAction', title: 'Pay rent' }] },
        ),
      moveTask: () => Effect.fail(new NotFoundError({ resource: 'task t1' })),
    };
    return Effect.gen(function* () {
      yield* seed;
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        notes: 'transfer first',
        title: 'Pay rent',
      });
      yield* (yield* EventMutations).processPendingOps();
      expect(yield* queued).toEqual([]);
      expect(yield* rowAt('acc-1', 'list-2', 't1')).toBeDefined();
      expect(yield* rowAt('acc-1', 'list-1', 't1')).toBeUndefined();
    }).pipe(noYield, Effect.provide(testLayer(fake.client, paged)));
  });

  it.effect('subtask copies go in one after another, so a retry cannot swap them', () => {
    const fake = fakeWith();
    const calls: Array<string> = [];
    let refused = 0;
    const base = recordingTasks(calls);
    const flakyInsert: GoogleTasksClientShape = {
      ...base,
      // The retry first checks whether the refused insert landed after all.
      insertTask: (params) =>
        params.task.title === 'Second step' && refused++ === 0
          ? Effect.fail(new ApiUnavailableError({ cause: 'try later' }))
          : base.insertTask(params),
      listTasks: () => Effect.succeed({ items: [] }),
    };
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      yield* move(['acc-1', 'list-1', 't1'], ['acc-2', 'list-x'], {
        dueDate: tomorrow,
        title: 'Pay rent',
      });
      const mutations = yield* EventMutations;
      yield* mutations.processPendingOps();
      // The second step backs off; the first waits behind it.
      expect(calls.filter((call) => call.startsWith('insert'))).toEqual(['insert list-x/Pay rent']);
      yield* TestClock.adjust('1 hour');
      yield* mutations.processPendingOps();
      expect(calls.filter((call) => call.startsWith('insert'))).toEqual([
        'insert list-x/Pay rent',
        'insert list-x/Second step under srv-1',
        'insert list-x/First step under srv-1',
      ]);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, flakyInsert)));
  });

  it.effect('a move into a list that is gone is put back, not retried forever', () => {
    const fake = fakeWith();
    const goneList: GoogleTasksClientShape = {
      ...recordingTasks([]),
      listTasks: () => Effect.fail(new NotFoundError({ resource: 'task list list-2' })),
      moveTask: () => Effect.fail(new NotFoundError({ resource: 'task list list-2' })),
    };
    return Effect.gen(function* () {
      yield* seed;
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        notes: 'transfer first',
        title: 'Pay rent',
      });
      yield* (yield* EventMutations).processPendingOps();
      expect(yield* queued).toEqual([]);
      expect(yield* rowAt('acc-1', 'list-1', 't1')).toBeDefined();
      expect(yield* rowAt('acc-1', 'list-2', 't1')).toBeUndefined();
    }).pipe(noYield, Effect.provide(testLayer(fake.client, goneList)));
  });

  it.effect('a discarded move sends the deletes of a parent and its subtasks to the source', () => {
    const fake = fakeWith();
    const flaky: GoogleTasksClientShape = {
      ...recordingTasks([]),
      moveTask: () => Effect.fail(new ApiUnavailableError({ cause: 'try later' })),
    };
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        notes: 'transfer first',
        title: 'Pay rent',
      });
      const mutations = yield* EventMutations;
      yield* mutations.deleteTask({ accountId: 'acc-1', taskId: 't1', taskListId: 'list-2' });
      const moveOp = (yield* (yield* PendingOpRepo).listAll()).find((op) => op.kind === 'moveTask');
      yield* mutations.discardPendingOp(moveOp!.id);
      // The deletes go to the source, the subtasks' (which name their
      // parent) included; nothing comes back in either list.
      expect(yield* queued).toEqual([
        'deleteTask acc-1/list-1/s1',
        'deleteTask acc-1/list-1/s2',
        'deleteTask acc-1/list-1/t1',
      ]);
      for (const listId of ['list-1', 'list-2']) {
        expect(yield* rowAt('acc-1', listId, 's1')).toBeUndefined();
        expect(yield* rowAt('acc-1', listId, 't1')).toBeUndefined();
      }
    }).pipe(noYield, Effect.provide(testLayer(fake.client, flaky)));
  });

  it.effect('a pull holding the queue keeps a move from landing mid-request', () => {
    const fake = fakeWith();
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const release = yield* Deferred.make<void>();
      const pull = yield* Effect.forkChild(mutations.whileQueueHeld(Deferred.await(release)));
      yield* Effect.yieldNow;
      yield* move(['acc-1', 'list-1', 't1'], ['acc-1', 'list-2'], {
        dueDate: tomorrow,
        notes: 'transfer first',
        title: 'Pay rent',
      });
      const drain = yield* Effect.forkChild(mutations.processPendingOps());
      yield* Effect.yieldNow;
      expect(calls).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pull);
      yield* Fiber.join(drain);
      expect(calls).toEqual(['move list-1/t1 -> list-2']);
    }).pipe(Effect.provide(testLayer(fake.client, recordingTasks(calls))));
  });

  it.effect(
    'deleting a parent whose create never went out drops the subtasks waiting on it',
    () => {
      const fake = fakeWith();
      return Effect.gen(function* () {
        yield* seed;
        yield* withSubtasks;
        const copied = yield* move(['acc-1', 'list-1', 't1'], ['acc-2', 'list-x'], {
          dueDate: tomorrow,
          title: 'Pay rent',
        });
        yield* (yield* EventMutations).deleteTask({
          accountId: 'acc-2',
          taskId: copied.id,
          taskListId: 'list-x',
        });
        expect(yield* (yield* TaskRepo).getMirrorSource('acc-2', ['list-x'])).toEqual([]);
        expect((yield* queued).filter((entry) => entry.includes('acc-2/'))).toEqual([]);
      }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
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

describe('deleting a Google parent task', () => {
  it.effect('takes its subtasks first, each a delete of its own, as Google does', () => {
    const fake = fakeWith();
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      const mutations = yield* EventMutations;
      yield* mutations.deleteTask({ accountId: 'acc-1', taskId: 't1', taskListId: 'list-1' });
      for (const id of ['t1', 's1', 's2']) {
        expect(yield* rowAt('acc-1', 'list-1', id)).toBeUndefined();
      }
      expect(yield* queued).toEqual([
        'deleteTask acc-1/list-1/s1',
        'deleteTask acc-1/list-1/s2',
        'deleteTask acc-1/list-1/t1',
      ]);
      // A discard puts back what its own delete removed, and only that.
      const [first] = yield* (yield* PendingOpRepo).listAll();
      yield* mutations.discardPendingOp(first!.id);
      expect((yield* rowAt('acc-1', 'list-1', 's1'))?.parentId).toBe('t1');
      expect(yield* rowAt('acc-1', 'list-1', 't1')).toBeUndefined();
      yield* mutations.processPendingOps();
      expect(calls).toEqual(['delete list-1/s2', 'delete list-1/t1']);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks(calls))));
  });

  it.effect('the preview counts the subtasks a delete takes: a parent’s, nothing else’s', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      const mutations = yield* EventMutations;
      const preview = (accountId: string, taskListId: string, taskId: string) =>
        mutations.previewDeleteTask({ accountId, taskId, taskListId });
      expect(yield* preview('acc-1', 'list-1', 't1')).toEqual({ subtasks: 2 });
      expect(yield* preview('acc-1', 'list-1', 's1')).toEqual({ subtasks: 0 });
      expect(yield* preview(APPLE, 'list-a', 'rem-timed')).toEqual({ subtasks: 0 });
      // Asking writes nothing.
      expect(yield* queued).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });

  it.effect('a subtask alone goes alone; its parent stays', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtasks;
      yield* (yield* EventMutations).deleteTask({
        accountId: 'acc-1',
        taskId: 's1',
        taskListId: 'list-1',
      });
      expect(yield* queued).toEqual(['deleteTask acc-1/list-1/s1']);
      expect(yield* rowAt('acc-1', 'list-1', 't1')).toBeDefined();
      expect(yield* rowAt('acc-1', 'list-1', 's2')).toBeDefined();
    }).pipe(noYield, Effect.provide(testLayer(fake.client, recordingTasks([]))));
  });
});
