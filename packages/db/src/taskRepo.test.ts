import { TaskListInfo, TaskRecord } from '@calendar/core';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { runMigrations } from './migrate.ts';
import { reposLayer, TaskRepo } from './repos.ts';

const freshDbLayer = () =>
  reposLayer.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

const list = (overrides: Partial<TaskListInfo> = {}): TaskListInfo =>
  new TaskListInfo({
    accountId: 'acc-1',
    id: 'list-1',
    isVisible: true,
    provider: 'google',
    title: 'My Tasks',
    ...overrides,
  });

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord =>
  new TaskRecord({
    accountId: 'acc-1',
    dueDate: '2026-08-30',
    id: 'task-1',
    listId: 'list-1',
    provider: 'google',
    status: 'needsAction',
    title: 'Pay rent',
    updatedAt: 100,
    ...overrides,
  });

describe('TaskRepo', () => {
  it.effect('round-trips tasks through the due-window query', () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo;
      yield* repo.upsertLists([list()], 100);
      yield* repo.upsertTasks([task()], 100);
      const window = yield* repo.getWindow('2026-08-24', '2026-08-31');
      expect(window).toHaveLength(1);
      expect(window[0]?.title).toBe('Pay rent');
      // Outside the window: nothing.
      expect(yield* repo.getWindow('2026-09-01', '2026-09-08')).toHaveLength(0);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('hides tasks of hidden lists and undated tasks', () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo;
      yield* repo.upsertLists([list()], 100);
      yield* repo.upsertTasks([task(), task({ dueDate: undefined, id: 'task-2' })], 100);
      yield* repo.setListVisible('acc-1', 'list-1', false);
      expect(yield* repo.getWindow('2026-08-24', '2026-08-31')).toHaveLength(0);
      yield* repo.setListVisible('acc-1', 'list-1', true);
      // The undated task never appears in a window.
      expect(yield* repo.getWindow('2026-08-24', '2026-08-31')).toHaveLength(1);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('preserves the local visibility toggle across list upserts', () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo;
      yield* repo.upsertLists([list()], 100);
      yield* repo.setListVisible('acc-1', 'list-1', false);
      // A later pull must not resurrect the list.
      yield* repo.upsertLists([list({ title: 'Renamed' })], 200);
      const lists = yield* repo.listLists('acc-1');
      expect(lists[0]?.isVisible).toBe(false);
      expect(lists[0]?.title).toBe('Renamed');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('setStatus flips completion optimistically', () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo;
      yield* repo.upsertLists([list()], 100);
      yield* repo.upsertTasks([task()], 100);
      yield* repo.setStatus({
        accountId: 'acc-1',
        completedAt: 500,
        listId: 'list-1',
        status: 'completed',
        taskId: 'task-1',
      });
      const [row] = yield* repo.getWindow('2026-08-24', '2026-08-31');
      expect(row?.status).toBe('completed');
      expect(row?.completedAt).toBe(500);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('deleteStale removes only rows from before the pass', () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo;
      yield* repo.upsertLists([list()], 100);
      yield* repo.upsertTasks([task()], 100);
      yield* repo.upsertTasks([task({ dueDate: '2026-08-29', id: 'task-2' })], 200);
      yield* repo.deleteStale('acc-1', 'list-1', 150);
      const window = yield* repo.getWindow('2026-08-24', '2026-08-31');
      expect(window.map((row) => row.id)).toEqual(['task-2']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('deleteStale spares unpushed local creates', () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo;
      yield* repo.upsertLists([list()], 100);
      yield* repo.insertLocal(task({ id: 'local-abc', updatedAt: 50 }));
      // A full pass at t=200 must not eat the pending row.
      yield* repo.deleteStale('acc-1', 'list-1', 200);
      const window = yield* repo.getWindow('2026-08-24', '2026-08-31');
      expect(window.map((row) => row.id)).toEqual(['local-abc']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('replaceId swaps a temp id and marks the row synced', () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo;
      yield* repo.upsertLists([list()], 100);
      yield* repo.insertLocal(task({ id: 'local-abc' }));
      yield* repo.replaceId('acc-1', 'list-1', 'local-abc', 'server-9');
      // Now a synced row: deleteStale applies again.
      yield* repo.deleteStale('acc-1', 'list-1', 9_999_999_999_999);
      expect(yield* repo.getWindow('2026-08-24', '2026-08-31')).toHaveLength(0);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('removeListsMissing drops vanished lists and their tasks', () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo;
      yield* repo.upsertLists([list(), list({ id: 'list-2', title: 'Other' })], 100);
      yield* repo.upsertTasks([task(), task({ id: 'task-2', listId: 'list-2' })], 100);
      yield* repo.removeListsMissing('acc-1', ['list-1']);
      expect(yield* repo.listLists('acc-1')).toHaveLength(1);
      const window = yield* repo.getWindow('2026-08-24', '2026-08-31');
      expect(window.map((row) => row.listId)).toEqual(['list-1']);
    }).pipe(Effect.provide(freshDbLayer())),
  );
  it.effect('orders timed reminders first and joins the list provider + color', () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo;
      yield* repo.upsertLists([list({ colorHex: '#ff0000', id: 'list-a', provider: 'apple' })], 1);
      yield* repo.upsertTasks(
        [
          task({ dueDate: '2030-01-02', id: 'allday', listId: 'list-a', title: 'A' }),
          task({
            alarms: [-15],
            dueDate: '2030-01-02',
            dueTime: '09:00',
            id: 'timed',
            listId: 'list-a',
            priority: 'high',
            title: 'Z',
            url: 'https://example.com',
          }),
        ],
        1,
      );
      const rows = yield* repo.getWindow('2030-01-01', '2030-01-03');
      expect(rows.map((row) => row.id)).toEqual(['timed', 'allday']);
      expect(rows[0]).toMatchObject({
        alarms: [-15],
        dueTime: '09:00',
        priority: 'high',
        provider: 'apple',
        url: 'https://example.com',
      });
      expect(rows[1]?.provider).toBe('apple');
      const lists = yield* repo.listLists('acc-1');
      expect(lists[0]).toMatchObject({ colorHex: '#ff0000', provider: 'apple' });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('updateLocal moves a row between lists and null clears reminder fields', () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo;
      yield* repo.upsertLists(
        [list({ id: 'list-a', provider: 'apple' }), list({ id: 'list-b', provider: 'apple' })],
        1,
      );
      yield* repo.upsertTasks(
        [
          task({
            dueDate: '2030-01-02',
            dueTime: '09:00',
            id: 'r1',
            listId: 'list-a',
            priority: 'low',
            recurrence: { freq: 'daily', interval: 1 },
          }),
        ],
        1,
      );
      yield* repo.updateLocal({
        accountId: 'acc-1',
        changes: { dueTime: null, listId: 'list-b', priority: null, recurrence: null },
        listId: 'list-a',
        taskId: 'r1',
      });
      const rows = yield* repo.getWindow('2030-01-01', '2030-01-03');
      expect(rows.length).toBe(1);
      expect(rows[0]?.listId).toBe('list-b');
      expect(rows[0]?.dueTime).toBeUndefined();
      expect(rows[0]?.priority).toBeUndefined();
      expect(rows[0]?.recurrence).toBeUndefined();
    }).pipe(Effect.provide(freshDbLayer())),
  );
});
