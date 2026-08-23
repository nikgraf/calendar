import { Account, TaskListInfo, TaskRecord } from '@calendar/core';
import { AccountRepo, reposLayer, TaskRepo } from '@calendar/db';
import { runMigrations } from '@calendar/db';
import {
  GoogleCalendarClient,
  GoogleTasksClient,
  InsufficientScopeError,
  NotFoundError,
  type GcalTasksPage,
  type GoogleCalendarClientShape,
  type GoogleTasksClientShape,
} from '@calendar/google';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';
import { PendingOpRepo } from '@calendar/db';

/** Calendar sync is exercised elsewhere; keep it inert here. */
const inertCalendarClient: GoogleCalendarClientShape = {
  deleteEvent: () => Effect.void,
  getColors: () => Effect.succeed({ calendar: {} }),
  insertEvent: () => Effect.die('not used'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  patchCalendarListEntry: () => Effect.die('not used'),
  patchEvent: () => Effect.die('not used'),
};

const testLayer = (tasksClient: GoogleTasksClientShape) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, inertCalendarClient)),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, tasksClient)),
  );

const seedAccount = (tasksEnabled: boolean) =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo;
    yield* accounts.upsert(
      new Account({
        createdAt: 1,
        email: 'nik@nikgraf.com',
        id: 'acc-1',
        status: 'ok',
        tasksEnabled,
      }),
    );
  });

const lists = { items: [{ id: 'list-1', title: 'My Tasks' }] };

describe('tasks sync', () => {
  it.effect('pulls lists and tasks, then advances the updatedMin watermark', () => {
    const updatedMins: Array<string | undefined> = [];
    const pages: Array<GcalTasksPage> = [
      {
        items: [
          {
            due: '2026-08-30T00:00:00.000Z',
            id: 't1',
            status: 'needsAction',
            title: 'Pay rent',
            updated: '2026-08-20T00:00:00.000Z',
          },
        ],
      },
      { items: [] },
    ];
    const client: GoogleTasksClientShape = {
      listTaskLists: () => Effect.succeed(lists),
      listTasks: ({ params }) => {
        updatedMins.push(params.updatedMin);
        return Effect.succeed(pages.shift() ?? { items: [] });
      },
      patchTask: () => Effect.die('not used'),
    };
    return Effect.gen(function* () {
      yield* seedAccount(true);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      const repo = yield* TaskRepo;
      expect(yield* repo.getWindow('2026-08-24', '2026-08-31')).toHaveLength(1);
      // First pass is full (no watermark); the second sends an RFC3339 one.
      yield* engine.syncAll();
      expect(updatedMins[0]).toBeUndefined();
      expect(updatedMins[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }).pipe(Effect.provide(testLayer(client)));
  });

  it.effect('removes tombstoned tasks on incremental polls', () => {
    let call = 0;
    const client: GoogleTasksClientShape = {
      listTaskLists: () => Effect.succeed(lists),
      listTasks: () => {
        call += 1;
        return Effect.succeed(
          call === 1
            ? {
                items: [
                  {
                    due: '2026-08-30T00:00:00.000Z',
                    id: 't1',
                    status: 'needsAction',
                    title: 'Pay rent',
                  },
                ],
              }
            : { items: [{ deleted: true, id: 't1' }] },
        );
      },
      patchTask: () => Effect.die('not used'),
    };
    return Effect.gen(function* () {
      yield* seedAccount(true);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      yield* engine.syncAll();
      const repo = yield* TaskRepo;
      expect(yield* repo.getWindow('2026-08-24', '2026-08-31')).toHaveLength(0);
    }).pipe(Effect.provide(testLayer(client)));
  });

  it.effect('does not touch the tasks API for accounts without the scope', () => {
    const client: GoogleTasksClientShape = {
      listTaskLists: () => Effect.die('must not be called'),
      listTasks: () => Effect.die('must not be called'),
      patchTask: () => Effect.die('must not be called'),
    };
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
    }).pipe(Effect.provide(testLayer(client)));
  });

  it.effect('flips tasksEnabled off when the scope turns out to be missing', () => {
    const client: GoogleTasksClientShape = {
      listTaskLists: () => Effect.fail(new InsufficientScopeError({ message: 'scope' })),
      listTasks: () => Effect.die('unreachable'),
      patchTask: () => Effect.die('unreachable'),
    };
    return Effect.gen(function* () {
      yield* seedAccount(true);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      const accounts = yield* AccountRepo;
      const [account] = yield* accounts.list();
      expect(account?.tasksEnabled).toBe(false);
      // Calendar sync keeps working: status is untouched.
      expect(account?.status).toBe('ok');
    }).pipe(Effect.provide(testLayer(client)));
  });
});

describe('completeTask', () => {
  const seedTasks = Effect.gen(function* () {
    yield* seedAccount(true);
    const repo = yield* TaskRepo;
    yield* repo.upsertLists(
      [new TaskListInfo({ accountId: 'acc-1', id: 'list-1', isVisible: true, title: 'My Tasks' })],
      100,
    );
    yield* repo.upsertTasks(
      [
        new TaskRecord({
          accountId: 'acc-1',
          dueDate: '2026-08-30',
          id: 't1',
          listId: 'list-1',
          status: 'needsAction',
          title: 'Pay rent',
          updatedAt: 100,
        }),
      ],
      100,
    );
  });

  it.effect('writes optimistically, pushes, and upserts the response', () => {
    const patches: Array<string> = [];
    const client: GoogleTasksClientShape = {
      listTaskLists: () => Effect.succeed(lists),
      listTasks: () => Effect.succeed({ items: [] }),
      patchTask: ({ status, taskId }) => {
        patches.push(`${taskId}:${status}`);
        return Effect.succeed({
          completed: '2026-08-23T10:00:00.000Z',
          due: '2026-08-30T00:00:00.000Z',
          id: taskId,
          status,
          title: 'Pay rent (server copy)',
          updated: '2026-08-23T10:00:00.000Z',
        });
      },
    };
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      yield* mutations.completeTask({
        accountId: 'acc-1',
        status: 'completed',
        taskId: 't1',
        taskListId: 'list-1',
      });
      yield* mutations.processPendingOps();
      expect(patches).toEqual(['t1:completed']);
      const repo = yield* TaskRepo;
      const [row] = yield* repo.getWindow('2026-08-24', '2026-08-31');
      // The response upsert is authoritative.
      expect(row?.title).toBe('Pay rent (server copy)');
      expect(row?.status).toBe('completed');
      const ops = yield* PendingOpRepo;
      expect(yield* ops.listAll()).toHaveLength(0);
    }).pipe(Effect.provide(testLayer(client)));
  });

  it.effect('coalesces to the latest toggle', () => {
    const patches: Array<string> = [];
    const client: GoogleTasksClientShape = {
      listTaskLists: () => Effect.succeed(lists),
      listTasks: () => Effect.succeed({ items: [] }),
      patchTask: ({ status, taskId }) => {
        patches.push(`${taskId}:${status}`);
        return Effect.succeed({ id: taskId, status, title: 'x' });
      },
    };
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      const toggle = (status: 'completed' | 'needsAction') =>
        mutations.completeTask({ accountId: 'acc-1', status, taskId: 't1', taskListId: 'list-1' });
      yield* toggle('completed');
      yield* toggle('needsAction');
      yield* mutations.processPendingOps();
      // Only the last state reached Google.
      expect(patches).toEqual(['t1:needsAction']);
    }).pipe(Effect.provide(testLayer(client)));
  });

  it.effect('drops the local row when Google reports the task gone', () => {
    const client: GoogleTasksClientShape = {
      listTaskLists: () => Effect.succeed(lists),
      listTasks: () => Effect.succeed({ items: [] }),
      patchTask: () => Effect.fail(new NotFoundError({ resource: 't1' })),
    };
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      yield* mutations.completeTask({
        accountId: 'acc-1',
        status: 'completed',
        taskId: 't1',
        taskListId: 'list-1',
      });
      yield* mutations.processPendingOps();
      const repo = yield* TaskRepo;
      expect(yield* repo.getWindow('2026-08-24', '2026-08-31')).toHaveLength(0);
      const ops = yield* PendingOpRepo;
      expect(yield* ops.listAll()).toHaveLength(0);
    }).pipe(Effect.provide(testLayer(client)));
  });

  it.effect('rejects unknown task lists', () =>
    Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      const result = yield* Effect.flip(
        mutations.completeTask({
          accountId: 'acc-1',
          status: 'completed',
          taskId: 't1',
          taskListId: 'no-such-list',
        }),
      );
      expect(result._tag).toBe('TaskNotFoundError');
    }).pipe(
      Effect.provide(
        testLayer({
          listTaskLists: () => Effect.die('not used'),
          listTasks: () => Effect.die('not used'),
          patchTask: () => Effect.die('not used'),
        }),
      ),
    ),
  );
});
