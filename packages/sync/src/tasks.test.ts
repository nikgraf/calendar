import { Account, TaskListInfo, TaskRecord } from '@calendar/core';
import { AccountRepo, reposLayer, TaskRepo } from '@calendar/db';
import { runMigrations } from '@calendar/db';
import {
  ApiUnavailableError,
  type GcalTasksPage,
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
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';
import { PendingOpRepo } from '@calendar/db';

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
  insertEvent: () => Effect.die('not used'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  patchCalendarListEntry: () => Effect.die('not used'),
  patchEvent: () => Effect.die('not used'),
};

/** Contacts sync is exercised in contacts.test.ts; keep it inert here. */
const inertPeopleClient: GooglePeopleClientShape = {
  listConnections: () => Effect.die('people not used in this test'),
  listOtherContacts: () => Effect.die('people not used in this test'),
};

const testLayer = (tasksClient: GoogleTasksClientShape) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
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
        email: 'nik@nikgraf.com',
        id: 'acc-1',
        provider: 'google',
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
    const client: GoogleTasksClientShape = tasksClient({
      listTaskLists: () => Effect.succeed(lists),
      listTasks: ({ params }) => {
        updatedMins.push(params.updatedMin);
        return Effect.succeed(pages.shift() ?? { items: [] });
      },
      patchTask: () => Effect.die('not used'),
    });
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
    const client: GoogleTasksClientShape = tasksClient({
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
    });
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
    const client: GoogleTasksClientShape = tasksClient({
      listTaskLists: () => Effect.die('must not be called'),
      listTasks: () => Effect.die('must not be called'),
      patchTask: () => Effect.die('must not be called'),
    });
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(client)));
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
    }).pipe(Effect.provide(testLayer(tasksClient({})))),
  );
});
