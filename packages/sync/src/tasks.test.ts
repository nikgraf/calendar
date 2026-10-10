import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { Account, TaskListInfo, TaskRecord } from '@calendar/core';
import { AccountRepo, reposLayer, TaskRepo } from '@calendar/db';
import { runMigrations } from '@calendar/db';
import {
  ApiUnavailableError,
  GoogleApiError,
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GooglePeopleClient,
  type GooglePeopleClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
  InsufficientScopeError,
  NotFoundError,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Scheduler } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { SqlClient } from 'effect/sql/SqlClient';
import { describe } from 'vite-plus/test';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';
import { PendingOpRepo } from '@calendar/db';

/**
 * Mutations fork the queue drain detached; a fiber yield between two
 * mutations would let it push the first before the second coalesces it.
 * The default yield cadence (2048 ops) is reached at a point that moves
 * with every migration, so pin it: the test body runs to its own explicit
 * processPendingOps without yielding.
 */
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

/** Fills the unused client methods with loud failures. */
const tasksClient = (overrides: Partial<GoogleTasksClientShape>): GoogleTasksClientShape => ({
  deleteTask: () => Effect.die('unexpected deleteTask'),
  insertTask: () => Effect.die('unexpected insertTask'),
  listTaskLists: () => Effect.die('unexpected listTaskLists'),
  listTasks: () => Effect.die('unexpected listTasks'),
  patchTask: () => Effect.die('unexpected patchTask'),
  ...overrides,
});

/** Calendar sync is exercised elsewhere; keep it inert here. */
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

/** Contacts sync is exercised in contacts.test.ts; keep it inert here. */
const inertPeopleClient: GooglePeopleClientShape = {
  listConnections: () => Effect.die('people not used in this test'),
  listOtherContacts: () => Effect.die('people not used in this test'),
};

const testLayer = (tasksClient: GoogleTasksClientShape) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, inertCalendarClient)),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, tasksClient)),
    Layer.provideMerge(Layer.succeed(GooglePeopleClient, inertPeopleClient)),
  );

const seedAccount = (tasksEnabled: boolean) =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo;
    yield* accounts.upsert(
      new Account({
        contactsEnabled: false,
        createdAt: 1,
        email: 'nik@example.com',
        id: 'acc-1',
        provider: 'google',
        status: 'ok',
        tasksEnabled,
      }),
    );
  });

const lists = { items: [{ id: 'list-1', title: 'My Tasks' }] };

/** The task's row with its sync flag, which TaskRecord does not carry. */
const taskRow = (id: string) =>
  Effect.gen(function* () {
    const row = yield* (yield* TaskRepo).get('acc-1', 'list-1', id);
    const sql = yield* SqlClient;
    const [status] = yield* sql<{ sync_status: string }>`SELECT sync_status FROM tasks
      WHERE account_id = 'acc-1' AND list_id = 'list-1' AND id = ${id}`;
    return row ? { ...row, syncStatus: status?.sync_status } : undefined;
  });

/** An open task due 2026-08-30, as Google lists it. */
const openTask = (id: string) => ({
  due: '2026-08-30T00:00:00.000Z',
  id,
  status: 'needsAction' as const,
  title: `Task ${id}`,
  updated: '2026-08-20T00:00:00.000Z',
});

describe('tasks sync', () => {
  it.effect('a list whose tasks 404 keeps its rows and skips only itself', () => {
    let googleListsIt = true;
    const goneResponses: Array<'ok' | 'not-found'> = ['ok', 'not-found'];
    let listOneCalls = 0;
    const client: GoogleTasksClientShape = tasksClient({
      listTaskLists: () =>
        Effect.succeed({
          items: [
            ...(googleListsIt ? [{ id: 'list-gone', title: 'A deleted list' }] : []),
            { id: 'list-1', title: 'My Tasks' },
          ],
        }),
      listTasks: ({ taskListId }) =>
        taskListId === 'list-gone' && goneResponses.shift() === 'not-found'
          ? Effect.fail(new NotFoundError({ resource: taskListId }))
          : Effect.succeed({
              items:
                taskListId === 'list-gone'
                  ? [openTask('t-gone')]
                  : // A task added on Google shows up only if list-1 synced.
                    ++listOneCalls === 1
                    ? [openTask('t1')]
                    : [openTask('t1'), openTask('t2')],
            }),
    });
    return Effect.gen(function* () {
      yield* seedAccount(true);
      const engine = yield* SyncEngine;
      const repo = yield* TaskRepo;
      const listIds = Effect.map(repo.listLists('acc-1'), (rows) => rows.map((row) => row.id));
      const taskIds = Effect.map(repo.getWindow('2026-08-24', '2026-08-31'), (rows) =>
        rows.map((row) => row.id).sort(),
      );
      yield* engine.syncAll();
      expect(yield* taskIds).toEqual(['t-gone', 't1']);
      // The 404 pass: list-gone keeps its cached task, list-1 (sorted
      // after it) still syncs.
      yield* engine.syncAll();
      expect(yield* listIds).toEqual(['list-gone', 'list-1']);
      expect(yield* taskIds).toEqual(['t-gone', 't1', 't2']);
      // Once Google stops naming it, the full list pass removes it.
      googleListsIt = false;
      yield* engine.syncAll();
      expect(yield* listIds).toEqual(['list-1']);
      expect(yield* taskIds).toEqual(['t1', 't2']);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('does not touch the tasks API for accounts without the scope', () => {
    const client: GoogleTasksClientShape = tasksClient({
      listTaskLists: () => Effect.die('must not be called'),
      listTasks: () => Effect.die('must not be called'),
      patchTask: () => Effect.die('must not be called'),
    });
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('flips tasksEnabled off when the scope turns out to be missing', () => {
    const client: GoogleTasksClientShape = tasksClient({
      listTaskLists: () => Effect.fail(new InsufficientScopeError({ message: 'scope' })),
      listTasks: () => Effect.die('unreachable'),
      patchTask: () => Effect.die('unreachable'),
    });
    return Effect.gen(function* () {
      yield* seedAccount(true);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      const accounts = yield* AccountRepo;
      const [account] = yield* accounts.list();
      expect(account?.tasksEnabled).toBe(false);
      // Calendar sync keeps working: status is untouched.
      expect(account?.status).toBe('ok');
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });
});

describe('completeTask', () => {
  const seedTasks = Effect.gen(function* () {
    yield* seedAccount(true);
    const repo = yield* TaskRepo;
    yield* repo.upsertLists(
      [
        new TaskListInfo({
          accountId: 'acc-1',
          id: 'list-1',
          isVisible: true,
          provider: 'google',
          title: 'My Tasks',
        }),
      ],
      100,
    );
    yield* repo.upsertTasks(
      [
        new TaskRecord({
          accountId: 'acc-1',
          dueDate: '2026-08-30',
          id: 't1',
          listId: 'list-1',
          provider: 'google',
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
    const client: GoogleTasksClientShape = tasksClient({
      listTaskLists: () => Effect.succeed(lists),
      listTasks: () => Effect.succeed({ items: [] }),
      patchTask: ({ changes, taskId }) => {
        patches.push(`${taskId}:${changes.status}`);
        return Effect.succeed({
          completed: '2026-08-23T10:00:00.000Z',
          due: '2026-08-30T00:00:00.000Z',
          id: taskId,
          status: changes.status,
          title: 'Pay rent (server copy)',
          updated: '2026-08-23T10:00:00.000Z',
        });
      },
    });
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
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('a pull leaves a queued completion alone until the op is acked or abandoned', () => {
    let patchOutcome: 'rejected' | 'transient' = 'transient';
    const client: GoogleTasksClientShape = tasksClient({
      listTaskLists: () => Effect.succeed(lists),
      // The server still says needsAction on every pull.
      listTasks: () =>
        Effect.succeed({
          items: [
            {
              due: '2026-08-30T00:00:00.000Z',
              id: 't1',
              status: 'needsAction',
              title: 'Pay rent',
              updated: '2026-08-20T00:00:00.000Z',
            },
          ],
        }),
      patchTask: () =>
        patchOutcome === 'transient'
          ? Effect.fail(new ApiUnavailableError({ cause: 'offline' }))
          : Effect.fail(new GoogleApiError({ message: 'Invalid value', status: 400 })),
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const engine = yield* SyncEngine;
      const mutations = yield* EventMutations;
      const repo = yield* TaskRepo;
      const status = () =>
        Effect.map(
          repo.getWindow('2026-08-24', '2026-08-31'),
          (rows) => rows.find((row) => row.id === 't1')?.status,
        );
      yield* mutations.completeTask({
        accountId: 'acc-1',
        status: 'completed',
        taskId: 't1',
        taskListId: 'list-1',
      });
      yield* mutations.processPendingOps();
      yield* engine.syncAll();
      expect(yield* status()).toBe('completed');

      patchOutcome = 'rejected';
      const ops = yield* PendingOpRepo;
      for (const op of yield* ops.listAll()) {
        yield* ops.markFailed(op.id, op.attempts, 0, 'test');
      }
      yield* mutations.processPendingOps();
      expect(yield* ops.listAll()).toHaveLength(0);
      yield* engine.syncAll();
      expect(yield* status()).toBe('needsAction');
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('coalesces to the latest toggle', () => {
    const patches: Array<string> = [];
    const client: GoogleTasksClientShape = tasksClient({
      listTaskLists: () => Effect.succeed(lists),
      listTasks: () => Effect.succeed({ items: [] }),
      patchTask: ({ changes, taskId }) => {
        patches.push(`${taskId}:${changes.status}`);
        return Effect.succeed({ id: taskId, status: changes.status, title: 'x' });
      },
    });
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
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('drops the local row when Google reports the task gone', () => {
    const client: GoogleTasksClientShape = tasksClient({
      listTaskLists: () => Effect.succeed(lists),
      listTasks: () => Effect.succeed({ items: [] }),
      patchTask: () => Effect.fail(new NotFoundError({ resource: 't1' })),
    });
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
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('drops the op and disables tasks when the scope is revoked mid-queue', () => {
    const client: GoogleTasksClientShape = tasksClient({
      listTaskLists: () => Effect.succeed(lists),
      listTasks: () => Effect.succeed({ items: [] }),
      patchTask: () => Effect.fail(new InsufficientScopeError({ message: 'scope' })),
    });
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
      // Not retried forever: the op is gone and the account is flagged.
      const ops = yield* PendingOpRepo;
      expect(yield* ops.listAll()).toHaveLength(0);
      const accounts = yield* AccountRepo;
      const [account] = yield* accounts.list();
      expect(account?.tasksEnabled).toBe(false);
      // And the row is handed back to sync: left pending, pulls would skip
      // it for good once tasks are connected again.
      const sql = yield* SqlClient;
      const rows = yield* sql<{
        readonly sync_status: string;
      }>`SELECT sync_status FROM tasks WHERE id = 't1'`;
      expect(rows[0]?.sync_status).toBe('synced');
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('create pushes, swaps the temp id, and rewrites queued ops', () => {
    const calls: Array<string> = [];
    const client: GoogleTasksClientShape = tasksClient({
      insertTask: ({ task }) => {
        calls.push(`insert:${task.title}`);
        return Effect.succeed({
          due: task.due,
          id: 'server-1',
          status: 'needsAction',
          title: task.title,
          updated: '2026-08-24T10:00:00.000Z',
        });
      },
      patchTask: ({ changes, taskId }) => {
        calls.push(`patch:${taskId}:${changes.status}`);
        // Google's patch echoes the full resource, due included.
        return Effect.succeed({
          due: '2026-08-30T00:00:00.000Z',
          id: taskId,
          status: changes.status,
          title: 'Buy milk',
        });
      },
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      const ops = yield* PendingOpRepo;
      // Queue both while "offline": nothing processes until we say so.
      const temp = yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: '2026-08-30',
        taskListId: 'list-1',
        title: 'Buy milk',
      });
      expect(temp.id.startsWith('local-')).toBe(true);
      yield* mutations.completeTask({
        accountId: 'acc-1',
        status: 'completed',
        taskId: temp.id,
        taskListId: 'list-1',
      });
      yield* mutations.processPendingOps();
      // The create ran first, then the completion — against the SERVER id.
      expect(calls).toEqual(['insert:Buy milk', 'patch:server-1:completed']);
      expect(yield* ops.listAll()).toHaveLength(0);
      const repo = yield* TaskRepo;
      const window = yield* repo.getWindow('2026-08-24', '2026-08-31');
      const ids = window.map((row) => row.id);
      expect(ids).toContain('server-1');
      expect(ids.some((id) => id.startsWith('local-'))).toBe(false);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('create tolerates the server row arriving via a pull first', () => {
    let inserts = 0;
    const client: GoogleTasksClientShape = tasksClient({
      insertTask: ({ task }) => {
        inserts += 1;
        return Effect.succeed({
          due: task.due,
          id: 'server-race',
          status: 'needsAction',
          title: task.title,
        });
      },
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      const repo = yield* TaskRepo;
      const temp = yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: '2026-08-30',
        taskListId: 'list-1',
        title: 'Racy',
      });
      // A poll upserts the server copy while the temp row still exists —
      // the old UPDATE-based swap would PK-conflict here and retry the
      // non-idempotent insert.
      yield* repo.upsertTasks(
        [
          new TaskRecord({
            accountId: 'acc-1',
            dueDate: '2026-08-30',
            id: 'server-race',
            listId: 'list-1',
            provider: 'google',
            status: 'needsAction',
            title: 'Racy',
            updatedAt: 200,
          }),
        ],
        200,
      );
      yield* mutations.processPendingOps();
      expect(inserts).toBe(1);
      const window = yield* repo.getWindow('2026-08-24', '2026-08-31');
      const ids = window.map((row) => row.id);
      expect(ids.filter((id) => id === 'server-race')).toHaveLength(1);
      expect(ids.some((id) => id === temp.id)).toBe(false);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('a retry after a dispatched-but-lost insert adopts, not duplicates', () => {
    let attempts = 0;
    const client: GoogleTasksClientShape = tasksClient({
      insertTask: ({ task }) => {
        attempts += 1;
        // The first request "lands" on Google but the response is lost.
        return attempts === 1
          ? Effect.fail(new ApiUnavailableError({ cause: 'connection dropped' }))
          : Effect.die('a second insert would duplicate the task');
      },
      listTasks: ({ params }) =>
        Effect.succeed(
          // On the verify pass the task the first request created is there.
          params.updatedMin
            ? {
                items: [
                  {
                    due: '2026-08-30T00:00:00.000Z',
                    id: 'server-landed',
                    status: 'needsAction',
                    title: 'Pay insurance',
                    updated: '2026-08-24T10:00:00.000Z',
                  },
                ],
              }
            : { items: [] },
        ),
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: '2026-08-30',
        taskListId: 'list-1',
        title: 'Pay insurance',
      });
      // First drain: dispatch stamped, insert "fails" after landing.
      yield* mutations.processPendingOps();
      const ops = yield* PendingOpRepo;
      const [pending] = yield* ops.listAll();
      expect(pending?.dispatchedAt).toBeDefined();
      // Backoff would delay the retry; force it due and drain again.
      yield* ops.markFailed(pending!.id, pending!.attempts, 0, 'test');
      yield* mutations.processPendingOps();
      expect(attempts).toBe(1);
      expect(yield* ops.listAll()).toHaveLength(0);
      const repo = yield* TaskRepo;
      const window = yield* repo.getWindow('2026-08-24', '2026-08-31');
      expect(window.some((row) => row.id === 'server-landed')).toBe(true);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('a dispatched retry with no server match inserts normally', () => {
    let attempts = 0;
    const client: GoogleTasksClientShape = tasksClient({
      insertTask: ({ task }) => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(new ApiUnavailableError({ cause: 'connection dropped' }))
          : Effect.succeed({
              due: task.due,
              id: 'server-fresh',
              status: 'needsAction',
              title: task.title,
            });
      },
      // The first request never landed: nothing to adopt.
      listTasks: () => Effect.succeed({ items: [] }),
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: '2026-08-30',
        taskListId: 'list-1',
        title: 'Pay insurance',
      });
      yield* mutations.processPendingOps();
      const ops = yield* PendingOpRepo;
      const [pending] = yield* ops.listAll();
      yield* ops.markFailed(pending!.id, pending!.attempts, 0, 'test');
      yield* mutations.processPendingOps();
      expect(attempts).toBe(2);
      expect(yield* ops.listAll()).toHaveLength(0);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('an edit after a dispatched-but-lost insert still adopts, then patches', () => {
    let attempts = 0;
    const patches: Array<string> = [];
    const client: GoogleTasksClientShape = tasksClient({
      insertTask: () => {
        attempts += 1;
        // The first request "lands" on Google but the response is lost.
        return attempts === 1
          ? Effect.fail(new ApiUnavailableError({ cause: 'connection dropped' }))
          : Effect.die('a second insert would duplicate the task');
      },
      // On the verify pass the task is there — with the fields the insert
      // was sent, not the edited ones.
      listTasks: ({ params }) =>
        Effect.succeed(
          params.updatedMin
            ? {
                items: [
                  {
                    due: '2026-08-30T00:00:00.000Z',
                    id: 'server-landed',
                    status: 'needsAction',
                    title: 'Pay insurance',
                    updated: '2026-08-24T10:00:00.000Z',
                  },
                ],
              }
            : { items: [] },
        ),
      patchTask: ({ changes, taskId }) => {
        patches.push(`${taskId}|${changes.title ?? ''}`);
        return Effect.succeed({ id: taskId, status: 'needsAction', title: changes.title });
      },
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      const temp = yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: '2026-08-30',
        taskListId: 'list-1',
        title: 'Pay insurance',
      });
      yield* mutations.processPendingOps();
      // Edited while the create sits in backoff: the create must keep the
      // fields it was dispatched with, or the adopt check misses and a
      // second insert duplicates the task.
      yield* mutations.updateTask({
        accountId: 'acc-1',
        changes: { title: 'Pay insurance now' },
        taskId: temp.id,
        taskListId: 'list-1',
      });
      const ops = yield* PendingOpRepo;
      expect((yield* ops.listAll()).map((op) => op.kind)).toEqual(['createTask', 'updateTask']);
      for (const op of yield* ops.listAll()) {
        yield* ops.markFailed(op.id, op.attempts, 0, 'test');
      }
      yield* mutations.processPendingOps();
      expect(attempts).toBe(1);
      expect(patches).toEqual(['server-landed|Pay insurance now']);
      expect(yield* ops.listAll()).toHaveLength(0);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('a follower behind a create in backoff waits for the id swap', () => {
    let attempts = 0;
    const patches: Array<string> = [];
    const client: GoogleTasksClientShape = tasksClient({
      insertTask: ({ task }) => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(new ApiUnavailableError({ cause: 'connection dropped' }))
          : Effect.succeed({
              due: task.due,
              id: 'server-fresh',
              status: 'needsAction',
              title: task.title,
            });
      },
      // The first request never landed: nothing to adopt.
      listTasks: () => Effect.succeed({ items: [] }),
      patchTask: ({ changes, taskId }) => {
        patches.push(`${taskId}|${changes.title ?? ''}`);
        return Effect.succeed({ id: taskId, status: 'needsAction', title: changes.title });
      },
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      const temp = yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: '2026-08-30',
        taskListId: 'list-1',
        title: 'Draft',
      });
      yield* mutations.processPendingOps();
      yield* mutations.updateTask({
        accountId: 'acc-1',
        changes: { title: 'Final' },
        taskId: temp.id,
        taskListId: 'list-1',
      });
      // The edit is due now, the create is not: the patch must not run
      // against the temp id (Google would 404 and the row would be dropped).
      yield* mutations.processPendingOps();
      expect(patches).toEqual([]);
      const ops = yield* PendingOpRepo;
      expect((yield* ops.listAll()).map((op) => op.kind)).toEqual(['createTask', 'updateTask']);
      for (const op of yield* ops.listAll()) {
        yield* ops.markFailed(op.id, op.attempts, 0, 'test');
      }
      yield* mutations.processPendingOps();
      expect(attempts).toBe(2);
      expect(patches).toEqual(['server-fresh|Final']);
      expect(yield* ops.listAll()).toHaveLength(0);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('a create Google rejects for good takes its optimistic row with it', () => {
    const client: GoogleTasksClientShape = tasksClient({
      insertTask: () =>
        Effect.fail(new GoogleApiError({ message: 'Invalid value for title', status: 400 })),
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      const temp = yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: '2026-08-30',
        taskListId: 'list-1',
        title: 'Rejected',
      });
      yield* mutations.processPendingOps();
      expect(yield* (yield* PendingOpRepo).listAll()).toHaveLength(0);
      // The temp row was `pending`, which deleteStale never touches: it
      // used to render forever as a task Google never had.
      const window = yield* (yield* TaskRepo).getWindow('2026-08-24', '2026-08-31');
      expect(window.some((row) => row.id === temp.id)).toBe(false);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('edits fold into a still-queued create', () => {
    const inserts: Array<string> = [];
    const client: GoogleTasksClientShape = tasksClient({
      insertTask: ({ task }) => {
        inserts.push(`${task.title}|${task.notes ?? ''}`);
        return Effect.succeed({ id: 'server-2', status: 'needsAction', title: task.title });
      },
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      const temp = yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: '2026-08-30',
        taskListId: 'list-1',
        title: 'Draft',
      });
      yield* mutations.updateTask({
        accountId: 'acc-1',
        changes: { notes: 'remember the oat one', title: 'Buy milk' },
        taskId: temp.id,
        taskListId: 'list-1',
      });
      yield* mutations.processPendingOps();
      // One insert carrying the merged fields; no patch was ever queued.
      expect(inserts).toEqual(['Buy milk|remember the oat one']);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('update is latest-wins once the task exists upstream', () => {
    const patches: Array<string> = [];
    const client: GoogleTasksClientShape = tasksClient({
      patchTask: ({ changes, taskId }) => {
        patches.push(`${taskId}:${changes.title}`);
        return Effect.succeed({ id: taskId, status: 'needsAction', title: changes.title });
      },
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      const edit = (title: string) =>
        mutations.updateTask({
          accountId: 'acc-1',
          changes: { title },
          taskId: 't1',
          taskListId: 'list-1',
        });
      yield* edit('First');
      yield* edit('Second');
      yield* mutations.processPendingOps();
      expect(patches).toEqual(['t1:Second']);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('a newer edit of another field keeps the queued one’s fields', () => {
    const patches: Array<string> = [];
    const client: GoogleTasksClientShape = tasksClient({
      patchTask: ({ changes, taskId }) => {
        patches.push(`${taskId}|${changes.title ?? '-'}|${changes.due ?? '-'}`);
        return Effect.succeed({
          ...(changes.due ? { due: changes.due } : {}),
          id: taskId,
          status: 'needsAction',
          title: changes.title,
        });
      },
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      // Offline: a rename, then a new due day from a drag.
      yield* mutations.updateTask({
        accountId: 'acc-1',
        changes: { title: 'Renamed' },
        taskId: 't1',
        taskListId: 'list-1',
      });
      yield* mutations.updateTask({
        accountId: 'acc-1',
        changes: { dueDate: '2026-08-31' },
        taskId: 't1',
        taskListId: 'list-1',
      });
      const ops = yield* PendingOpRepo;
      expect((yield* ops.listAll()).map((op) => op.kind)).toEqual(['updateTask']);
      yield* mutations.processPendingOps();
      // One patch with both fields: the response used to overwrite the
      // local row with the old title.
      expect(patches).toEqual(['t1|Renamed|2026-08-31T00:00:00.000Z']);
      const window = yield* (yield* TaskRepo).getWindow('2026-08-24', '2026-09-07');
      expect(window.find((row) => row.id === 't1')?.title).toBe('Renamed');
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('deleting an unpushed create cancels everything locally', () => {
    // Every client method dies — nothing may reach Google.
    const client = tasksClient({});
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      const temp = yield* mutations.createTask({
        accountId: 'acc-1',
        dueDate: '2026-08-30',
        taskListId: 'list-1',
        title: 'Never mind',
      });
      yield* mutations.deleteTask({
        accountId: 'acc-1',
        taskId: temp.id,
        taskListId: 'list-1',
      });
      const ops = yield* PendingOpRepo;
      expect(yield* ops.listAll()).toHaveLength(0);
      const repo = yield* TaskRepo;
      const window = yield* repo.getWindow('2026-08-24', '2026-08-31');
      expect(window.some((row) => row.id === temp.id)).toBe(false);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('delete tolerates the task already being gone upstream', () => {
    const client: GoogleTasksClientShape = tasksClient({
      deleteTask: () => Effect.fail(new NotFoundError({ resource: 't1' })),
    });
    return Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      yield* mutations.deleteTask({ accountId: 'acc-1', taskId: 't1', taskListId: 'list-1' });
      yield* mutations.processPendingOps();
      const ops = yield* PendingOpRepo;
      expect(yield* ops.listAll()).toHaveLength(0);
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });

  it.effect('discarding a completion puts the task back open', () =>
    Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      yield* mutations.completeTask({
        accountId: 'acc-1',
        status: 'completed',
        taskId: 't1',
        taskListId: 'list-1',
      });
      const ops = yield* PendingOpRepo;
      const [op] = yield* ops.listAll();
      expect(op?.beforeTask?.status).toBe('needsAction');

      yield* mutations.discardPendingOp(op!.id);
      const row = yield* taskRow('t1');
      expect(row?.status).toBe('needsAction');
      expect(row?.completedAt).toBeUndefined();
      expect(row?.syncStatus).toBe('synced');
      expect(yield* ops.listAll()).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(tasksClient({})))),
  );

  it.effect('discarding a rename keeps a completion queued after it, and its tick', () =>
    Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      yield* mutations.updateTask({
        accountId: 'acc-1',
        changes: { title: 'Renamed' },
        taskId: 't1',
        taskListId: 'list-1',
      });
      yield* mutations.completeTask({
        accountId: 'acc-1',
        status: 'completed',
        taskId: 't1',
        taskListId: 'list-1',
      });
      const ops = yield* PendingOpRepo;
      const rename = (yield* ops.listAll()).find((op) => op.kind === 'updateTask');
      expect(rename?.beforeTask?.title).toBe('Pay rent');

      yield* mutations.discardPendingOp(rename!.id);
      const afterRename = yield* taskRow('t1');
      expect(afterRename?.title).toBe('Pay rent');
      expect(afterRename?.status).toBe('completed');
      expect(afterRename?.syncStatus).toBe('pending');

      const completion = (yield* ops.listAll()).find((op) => op.kind === 'completeTask');
      yield* mutations.discardPendingOp(completion!.id);
      const afterBoth = yield* taskRow('t1');
      expect(afterBoth?.status).toBe('needsAction');
      expect(afterBoth?.syncStatus).toBe('synced');
    }).pipe(noYield, Effect.provide(testLayer(tasksClient({})))),
  );

  it.effect('a delete after coalesced edits and a toggle remembers the acknowledged task', () =>
    Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      const rename = (title: string) =>
        mutations.updateTask({
          accountId: 'acc-1',
          changes: { title },
          taskId: 't1',
          taskListId: 'list-1',
        });
      // A rename, a completion, a second rename (which re-queues the edit
      // behind the completion), then the delete.
      yield* rename('Pay rent (B)');
      yield* mutations.completeTask({
        accountId: 'acc-1',
        status: 'completed',
        taskId: 't1',
        taskListId: 'list-1',
      });
      yield* rename('Pay rent (C)');
      yield* mutations.deleteTask({ accountId: 'acc-1', taskId: 't1', taskListId: 'list-1' });
      const ops = yield* PendingOpRepo;
      const [op] = yield* ops.listAll();
      expect(op?.kind).toBe('deleteTask');

      yield* mutations.discardPendingOp(op!.id);
      const row = yield* taskRow('t1');
      expect(row?.title).toBe('Pay rent');
      expect(row?.status).toBe('needsAction');
      expect(row?.syncStatus).toBe('synced');
    }).pipe(noYield, Effect.provide(testLayer(tasksClient({})))),
  );

  it.effect(
    'a pull that confirms a deletion leaves a queued task delete nothing to put back',
    () => {
      const client: GoogleTasksClientShape = tasksClient({
        deleteTask: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        listTaskLists: () => Effect.succeed(lists),
        // Deleted on Google by another client while the local delete waited.
        listTasks: () =>
          Effect.succeed({
            items: [{ deleted: true, id: 't1', updated: '2026-08-23T10:00:00.000Z' }],
          }),
      });
      return Effect.gen(function* () {
        yield* seedTasks;
        const mutations = yield* EventMutations;
        yield* mutations.deleteTask({ accountId: 'acc-1', taskId: 't1', taskListId: 'list-1' });
        yield* (yield* SyncEngine).syncAll();
        const ops = yield* PendingOpRepo;
        const [op] = yield* ops.listAll();
        expect(op?.kind).toBe('deleteTask');
        expect(op?.beforeTask).toBeUndefined();
        yield* mutations.discardPendingOp(op!.id);
        expect(yield* taskRow('t1')).toBeUndefined();
      }).pipe(noYield, Effect.provide(testLayer(client)));
    },
  );

  it.effect(
    'a rename that lands while its replacement is queued becomes what that replaces',
    () => {
      let release: (() => void) | undefined;
      let patches = 0;
      const client: GoogleTasksClientShape = tasksClient({
        patchTask: ({ changes, taskId }) =>
          patches++ === 0
            ? Effect.flatMap(
                Effect.promise(
                  () =>
                    new Promise<void>((resolve) => {
                      release = resolve;
                    }),
                ),
                () => Effect.succeed({ id: taskId, status: 'needsAction', title: changes.title }),
              )
            : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      });
      return Effect.gen(function* () {
        yield* seedTasks;
        const mutations = yield* EventMutations;
        const rename = (title: string) =>
          mutations.updateTask({
            accountId: 'acc-1',
            changes: { title },
            taskId: 't1',
            taskListId: 'list-1',
          });
        yield* rename('Pay rent (B)');
        const drain = yield* Effect.forkChild(mutations.processPendingOps());
        while (release === undefined) {
          yield* Effect.yieldNow;
        }
        yield* rename('Pay rent (C)');
        release();
        yield* Fiber.join(drain);

        const [op] = yield* (yield* PendingOpRepo).listAll();
        expect(op?.taskTitle).toBe('Pay rent (C)');
        expect(op?.beforeTask?.title).toBe('Pay rent (B)');
        yield* mutations.discardPendingOp(op!.id);
        expect((yield* taskRow('t1'))?.title).toBe('Pay rent (B)');
      }).pipe(Effect.provide(testLayer(client)));
    },
  );

  it.effect('discarding a delete brings the task back', () =>
    Effect.gen(function* () {
      yield* seedTasks;
      const mutations = yield* EventMutations;
      yield* mutations.deleteTask({ accountId: 'acc-1', taskId: 't1', taskListId: 'list-1' });
      expect(yield* taskRow('t1')).toBeUndefined();
      const ops = yield* PendingOpRepo;
      const [op] = yield* ops.listAll();
      expect(op?.beforeTask?.title).toBe('Pay rent');

      yield* mutations.discardPendingOp(op!.id);
      const row = yield* taskRow('t1');
      expect(row?.title).toBe('Pay rent');
      expect(row?.dueDate).toBe('2026-08-30');
      expect(row?.syncStatus).toBe('synced');
    }).pipe(noYield, Effect.provide(testLayer(tasksClient({})))),
  );

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
    }).pipe(Effect.provide(testLayer(tasksClient({})))),
  );
});

describe('tasks without a due day', () => {
  it.effect('a create without a due day pushes no due and stays undated', () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client: GoogleTasksClientShape = tasksClient({
      insertTask: ({ task }) => {
        bodies.push({ ...task });
        return Effect.succeed({
          id: 'server-undated',
          status: 'needsAction',
          title: task.title,
          updated: '2026-08-24T10:00:00.000Z',
        });
      },
    });
    return Effect.gen(function* () {
      yield* seedAccount(true);
      yield* (yield* TaskRepo).upsertLists(
        [
          new TaskListInfo({
            accountId: 'acc-1',
            id: 'list-1',
            isVisible: true,
            provider: 'google',
            title: 'My Tasks',
          }),
        ],
        100,
      );
      const mutations = yield* EventMutations;
      const temp = yield* mutations.createTask({
        accountId: 'acc-1',
        taskListId: 'list-1',
        title: 'Someday',
      });
      expect(temp.dueDate).toBeUndefined();
      yield* mutations.processPendingOps();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!['title']).toBe('Someday');
      expect(bodies[0]!['due']).toBeUndefined();
      const repo = yield* TaskRepo;
      // Undated tasks are read apart from any window (and drawn on today).
      const undated = yield* repo.getUndatedOpen();
      expect(undated.map((task) => task.id)).toEqual(['server-undated']);
      expect(undated[0]!.dueDate).toBeUndefined();
    }).pipe(noYield, Effect.provide(testLayer(client)));
  });
});
