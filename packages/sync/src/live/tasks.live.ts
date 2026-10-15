import { PendingOpRepo, TaskRepo } from '@calendar/db';
import type { EventMutationsShape } from '../mutationTypes.ts';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vite-plus/test';
import {
  LIVE_ACCOUNT_ID,
  liveEngineLayer,
  liveGoogleConfigFromEnv,
} from '../testing/liveGoogle.ts';
import {
  bootstrap,
  httpStatus,
  isoDay,
  noYield,
  pendingOps,
  syncUntil,
  titleFor,
  scratchFor,
  drain,
} from './support.ts';

/**
 * Google Tasks on the real API: server-assigned ids and the temp-id swap,
 * date-only dues (and taking one away), completion, the `updatedMin` watermark with deleted
 * tombstones, adopt-before-retry for a create whose response was lost,
 * a move between lists that keeps the id and takes subtasks along, a
 * move inside one list that nests, reorders and un-nests, the order
 * another device's move or insert leaves, which no `updated` reports, and
 * its move to another list, which the old list sends no tombstone for.
 */

const config = liveGoogleConfigFromEnv();
const scratch = scratchFor(config);
const listA = () => scratch.lists[0]!;
const listB = () => scratch.lists[1]!;

const create = (
  mutations: Pick<EventMutationsShape, 'createTask'>,
  name: string,
  extra: { readonly notes?: string } = {},
) =>
  mutations.createTask({
    accountId: LIVE_ACCOUNT_ID,
    dueDate: isoDay(1),
    taskListId: listA(),
    title: titleFor(config, name),
    ...extra,
  });

/** The row a temp id turned into: the local task with this title, or undefined. */
const localByTitle = (listId: string, title: string) =>
  Effect.gen(function* () {
    const rows = yield* (yield* TaskRepo).getWindow(isoDay(-1), isoDay(3));
    return rows.find((row) => row.listId === listId && row.title === title);
  });

describe('live Google: tasks', () => {
  it.live('both lists arrive; a create swaps its temp id for Google’s', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const lists = yield* (yield* TaskRepo).listLists(LIVE_ACCOUNT_ID);
      expect(lists.map((list) => list.id)).toEqual(expect.arrayContaining([listA(), listB()]));
      const temp = yield* create(mutations, 'create');
      expect(temp.id.startsWith('local-')).toBe(true);
      yield* drain(mutations);
      const row = yield* localByTitle(listA(), temp.title);
      expect(row?.id.startsWith('local-')).toBe(false);
      const server = yield* google.getTask(listA(), row!.id);
      expect(server.title).toBe(temp.title);
      expect(server.due?.slice(0, 10)).toBe(isoDay(1));
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('title, notes and due edits patch through; complete and un-complete round-trip', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const temp = yield* create(mutations, 'edit');
      yield* drain(mutations);
      const row = (yield* localByTitle(listA(), temp.title))!;
      yield* mutations.updateTask({
        accountId: LIVE_ACCOUNT_ID,
        changes: {
          dueDate: isoDay(2),
          notes: 'bring the charger',
          title: `${temp.title} (edited)`,
        },
        taskId: row.id,
        taskListId: listA(),
      });
      yield* drain(mutations);
      let server = yield* google.getTask(listA(), row.id);
      expect(server.title).toBe(`${temp.title} (edited)`);
      expect(server.notes).toBe('bring the charger');
      expect(server.due?.slice(0, 10)).toBe(isoDay(2));

      // `due: null` takes the day away again.
      yield* mutations.updateTask({
        accountId: LIVE_ACCOUNT_ID,
        changes: { dueDate: null },
        taskId: row.id,
        taskListId: listA(),
      });
      yield* drain(mutations);
      server = yield* google.getTask(listA(), row.id);
      expect(server.due).toBeUndefined();
      expect(server.title).toBe(`${temp.title} (edited)`);
      expect((yield* (yield* TaskRepo).get(LIVE_ACCOUNT_ID, listA(), row.id))?.dueDate).toBe(
        undefined,
      );

      yield* mutations.completeTask({
        accountId: LIVE_ACCOUNT_ID,
        status: 'completed',
        taskId: row.id,
        taskListId: listA(),
      });
      yield* drain(mutations);
      server = yield* google.getTask(listA(), row.id);
      expect(server.status).toBe('completed');
      expect(server.completed).toBeTruthy();

      yield* mutations.completeTask({
        accountId: LIVE_ACCOUNT_ID,
        status: 'needsAction',
        taskId: row.id,
        taskListId: listA(),
      });
      yield* drain(mutations);
      server = yield* google.getTask(listA(), row.id);
      expect(server.status).toBe('needsAction');
      expect(server.completed).toBeUndefined();
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('the watermark pass picks up a rename and a deleted tombstone', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const kept = yield* create(mutations, 'wm-kept');
      const gone = yield* create(mutations, 'wm-gone');
      yield* drain(mutations);
      const keptRow = (yield* localByTitle(listA(), kept.title))!;
      const goneRow = (yield* localByTitle(listA(), gone.title))!;
      yield* google.patchTask(listA(), keptRow.id, { title: `${kept.title} (renamed)` });
      yield* google.deleteTask(listA(), goneRow.id);
      const repo = yield* TaskRepo;
      const settled = yield* syncUntil(
        engine,
        Effect.gen(function* () {
          const renamed = yield* repo.get(LIVE_ACCOUNT_ID, listA(), keptRow.id);
          const removed = yield* repo.get(LIVE_ACCOUNT_ID, listA(), goneRow.id);
          return renamed?.title === `${kept.title} (renamed)` && removed === undefined;
        }),
      );
      expect(settled).toBe(true);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a task completed here and reopened on Google comes back open', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const temp = yield* create(mutations, 'reopen');
      yield* drain(mutations);
      const row = (yield* localByTitle(listA(), temp.title))!;
      yield* mutations.completeTask({
        accountId: LIVE_ACCOUNT_ID,
        status: 'completed',
        taskId: row.id,
        taskListId: listA(),
      });
      yield* drain(mutations);
      expect((yield* google.getTask(listA(), row.id)).status).toBe('completed');
      // Another device reopens it; the watermark pass must bring it back.
      yield* google.patchTask(listA(), row.id, { completed: null, status: 'needsAction' });
      const repo = yield* TaskRepo;
      const reopened = yield* syncUntil(
        engine,
        Effect.map(
          repo.get(LIVE_ACCOUNT_ID, listA(), row.id),
          (task) => task?.status === 'needsAction',
        ),
      );
      expect(reopened).toBe(true);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a local delete reaches Google', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const temp = yield* create(mutations, 'delete');
      yield* drain(mutations);
      const row = (yield* localByTitle(listA(), temp.title))!;
      yield* mutations.deleteTask({
        accountId: LIVE_ACCOUNT_ID,
        taskId: row.id,
        taskListId: listA(),
      });
      yield* drain(mutations);
      expect(yield* pendingOps).toEqual([]);
      // Pins the answer: a deleted task reads back as `deleted: true` or 404.
      const after = yield* google.getTask(listA(), row.id).pipe(
        Effect.map((task) => (task.deleted ? 'deleted' : task.status)),
        Effect.catchTag('LiveGoogleError', (error) => Effect.succeed(`http ${httpStatus(error)}`)),
      );
      expect(['deleted', 'http 404']).toContain(after);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a create whose first attempt landed is adopted instead of duplicated', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const title = titleFor(config, 'adopt');
      // "The first attempt": the identical task already on Google.
      yield* google.insertTask(listA(), { due: `${isoDay(1)}T00:00:00.000Z`, title });
      // Stamp the op as dispatched before any drain can run (no yield
      // between the enqueue and the stamp), then let the drain verify.
      yield* noYield(
        Effect.gen(function* () {
          yield* create(mutations, 'adopt');
          const [op] = yield* pendingOps;
          yield* (yield* PendingOpRepo).markDispatched(op!.id, Date.now() - 1000);
        }),
      );
      yield* drain(mutations);
      const onGoogle = (yield* google.listTasks(listA())).filter(
        (task) => task.title === title && !task.deleted,
      );
      expect(onGoogle).toHaveLength(1);
      expect((yield* localByTitle(listA(), title))?.id).toBe(onGoogle[0]!.id);
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live(
    'moving a task to another list moves it on Google: the id stays and its subtasks come along',
    () =>
      Effect.gen(function* () {
        const { engine, mutations, scratch: google } = yield* bootstrap(config);
        const repo = yield* TaskRepo;
        const temp = yield* create(mutations, 'move');
        yield* drain(mutations);
        const row = (yield* localByTitle(listA(), temp.title))!;
        // A subtask added on Google, as another device would.
        const step = yield* google.insertTask(
          listA(),
          { title: titleFor(config, 'move-step') },
          row.id,
        );
        const known = yield* syncUntil(
          engine,
          Effect.map(
            repo.get(LIVE_ACCOUNT_ID, listA(), step.id),
            (subtask) => subtask?.parentId === row.id,
          ),
        );
        expect(known).toBe(true);
        const preview = yield* mutations.previewMoveTask({
          accountId: LIVE_ACCOUNT_ID,
          target: { accountId: LIVE_ACCOUNT_ID, taskListId: listB() },
          taskId: row.id,
          taskListId: listA(),
        });
        expect(preview).toMatchObject({ leavesParent: false, subtasksUnnested: 0 });
        yield* mutations.moveTask({
          accountId: LIVE_ACCOUNT_ID,
          draft: { dueDate: isoDay(1), title: temp.title },
          target: { accountId: LIVE_ACCOUNT_ID, taskListId: listB() },
          taskId: row.id,
          taskListId: listA(),
        });
        yield* drain(mutations);
        expect(yield* pendingOps).toEqual([]);
        const ours = <T extends { readonly deleted?: boolean; readonly id: string }>(
          tasks: ReadonlyArray<T>,
        ) => tasks.filter((task) => !task.deleted && (task.id === row.id || task.id === step.id));
        const inB = ours(yield* google.listTasks(listB()));
        expect(inB.map((task) => `${task.id}<${task.parent ?? ''}`).sort()).toEqual(
          [`${row.id}<`, `${step.id}<${row.id}`].sort(),
        );
        expect(ours(yield* google.listTasks(listA()))).toEqual([]);
        expect((yield* repo.get(LIVE_ACCOUNT_ID, listB(), row.id))?.title).toBe(temp.title);
        expect((yield* repo.get(LIVE_ACCOUNT_ID, listB(), step.id))?.parentId).toBe(row.id);
        expect(yield* repo.get(LIVE_ACCOUNT_ID, listA(), step.id)).toBeUndefined();
      }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live(
    'a task nests, reorders and leaves its parent inside its list, and Google’s order comes back',
    () =>
      Effect.gen(function* () {
        const { mutations, scratch: google } = yield* bootstrap(config);
        const repo = yield* TaskRepo;
        const titles = [];
        for (const name of ['order-parent', 'order-a', 'order-b']) {
          titles.push((yield* create(mutations, name)).title);
        }
        yield* drain(mutations);
        const ids = [];
        for (const title of titles) {
          ids.push((yield* localByTitle(listA(), title))!.id);
        }
        const [parent, first, second] = ids as [string, string, string];
        const place = (taskId: string, placement: { parentId?: string; previousId?: string }) =>
          mutations.reorderTask({
            accountId: LIVE_ACCOUNT_ID,
            taskId,
            taskListId: listA(),
            ...placement,
          });
        yield* place(first, { parentId: parent });
        yield* place(second, { parentId: parent, previousId: first });
        yield* drain(mutations);
        expect(yield* pendingOps).toEqual([]);
        const [a, b] = [
          yield* google.getTask(listA(), first),
          yield* google.getTask(listA(), second),
        ];
        expect([a.parent, b.parent]).toEqual([parent, parent]);
        expect((a.position ?? '') < (b.position ?? '')).toBe(true);
        // Google bumps no `updated` on a move: these were read back, never pulled.
        const nested = yield* repo.listSubtasks(LIVE_ACCOUNT_ID, listA(), parent);
        expect(nested.map((row) => `${row.id}@${row.position ?? ''}`)).toEqual([
          `${first}@${a.position ?? ''}`,
          `${second}@${b.position ?? ''}`,
        ]);
        // Out again, right after its parent; the one left behind moves up.
        yield* place(first, { previousId: parent });
        yield* drain(mutations);
        expect((yield* google.getTask(listA(), first)).parent).toBeUndefined();
        expect((yield* repo.get(LIVE_ACCOUNT_ID, listA(), first))?.parentId).toBeUndefined();
        expect((yield* repo.get(LIVE_ACCOUNT_ID, listA(), second))?.position).toBe(
          (yield* google.getTask(listA(), second)).position,
        );
      }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('another device’s move and insert reach the order here on the next pass', () =>
    Effect.gen(function* () {
      const { engine, scratch: google } = yield* bootstrap(config);
      const repo = yield* TaskRepo;
      const task = (name: string) => ({
        due: `${isoDay(1)}T00:00:00.000Z`,
        title: titleFor(config, name),
      });
      const parent = yield* google.insertTask(listA(), task('elsewhere-parent'));
      const a = yield* google.insertTask(listA(), task('elsewhere-a'), parent.id);
      // Inserted first among the subtasks: A is renumbered, its `updated` stays.
      const b = yield* google.insertTask(listA(), task('elsewhere-b'), parent.id);
      const inGoogleOrder = Effect.map(google.listTasks(listA()), (tasks) =>
        tasks
          .filter((entry) => entry.parent === parent.id && !entry.deleted)
          .sort((x, y) => ((x.position ?? '') < (y.position ?? '') ? -1 : 1))
          .map((entry) => `${entry.id}@${entry.position ?? ''}`),
      );
      const here = Effect.map(repo.listSubtasks(LIVE_ACCOUNT_ID, listA(), parent.id), (rows) =>
        rows.map((row) => `${row.id}@${row.position ?? ''}`),
      );
      const agrees = (ids: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const theirs = yield* inGoogleOrder;
          const ours = yield* here;
          return (
            theirs.map((entry) => entry.split('@')[0]).join() === ids.join() &&
            ours.join() === theirs.join()
          );
        });
      expect(yield* syncUntil(engine, agrees([b.id, a.id]))).toBe(true);

      // A move bumps no task's `updated`: only the list's own says it happened.
      yield* google.moveTask(listA(), a.id, { parent: parent.id });
      expect(yield* syncUntil(engine, agrees([a.id, b.id]))).toBe(true);

      const c = yield* google.insertTask(listA(), task('elsewhere-c'), parent.id);
      expect(yield* syncUntil(engine, agrees([c.id, a.id, b.id]))).toBe(true);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('another device’s move to another list leaves the old list on the next pass', () =>
    Effect.gen(function* () {
      const { engine, scratch: google } = yield* bootstrap(config);
      const repo = yield* TaskRepo;
      const task = (name: string) => ({
        due: `${isoDay(1)}T00:00:00.000Z`,
        title: titleFor(config, name),
      });
      const parent = yield* google.insertTask(listA(), task('away-parent'));
      const step = yield* google.insertTask(listA(), task('away-step'), parent.id);
      const nestedIn = (listId: string) =>
        Effect.gen(function* () {
          const [row, subtask] = [
            yield* repo.get(LIVE_ACCOUNT_ID, listId, parent.id),
            yield* repo.get(LIVE_ACCOUNT_ID, listId, step.id),
          ];
          return row !== undefined && subtask?.parentId === parent.id;
        });
      expect(yield* syncUntil(engine, nestedIn(listA()))).toBe(true);
      const before = (yield* google.getTask(listA(), step.id)).updated;

      // Google lists neither in A afterwards, not even as tombstones, and
      // the subtask's `updated` moved with it: B's pull brings both.
      yield* google.moveTask(listA(), parent.id, { destination: listB() });
      const ours = (yield* google.listTasks(listA())).filter(
        (entry) => entry.id === parent.id || entry.id === step.id,
      );
      expect(ours).toEqual([]);
      expect((yield* google.getTask(listB(), step.id)).updated).not.toBe(before);
      const moved = Effect.gen(function* () {
        const leftBehind = [
          yield* repo.get(LIVE_ACCOUNT_ID, listA(), parent.id),
          yield* repo.get(LIVE_ACCOUNT_ID, listA(), step.id),
        ].filter((row) => row !== undefined);
        return leftBehind.length === 0 && (yield* nestedIn(listB()));
      });
      expect(yield* syncUntil(engine, moved)).toBe(true);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
