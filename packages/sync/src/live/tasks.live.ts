import { PendingOpRepo, TaskRepo } from '@calendar/db';
import type { EventMutationsShape } from '../mutationTypes.ts';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';
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
} from './support.ts';

/**
 * Google Tasks on the real API: server-assigned ids and the temp-id swap,
 * date-only dues, completion, the `updatedMin` watermark with deleted
 * tombstones, adopt-before-retry for a create whose response was lost,
 * and a copy-then-delete move between lists.
 */

const config = liveGoogleConfigFromEnv();
const scratch = scratchFor(config, { lists: ['tasks-a', 'tasks-b'] });
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
      yield* mutations.processPendingOps();
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
      yield* mutations.processPendingOps();
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
      yield* mutations.processPendingOps();
      let server = yield* google.getTask(listA(), row.id);
      expect(server.title).toBe(`${temp.title} (edited)`);
      expect(server.notes).toBe('bring the charger');
      expect(server.due?.slice(0, 10)).toBe(isoDay(2));

      yield* mutations.completeTask({
        accountId: LIVE_ACCOUNT_ID,
        status: 'completed',
        taskId: row.id,
        taskListId: listA(),
      });
      yield* mutations.processPendingOps();
      server = yield* google.getTask(listA(), row.id);
      expect(server.status).toBe('completed');
      expect(server.completed).toBeTruthy();

      yield* mutations.completeTask({
        accountId: LIVE_ACCOUNT_ID,
        status: 'needsAction',
        taskId: row.id,
        taskListId: listA(),
      });
      yield* mutations.processPendingOps();
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
      yield* mutations.processPendingOps();
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

  it.live('a local delete reaches Google', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const temp = yield* create(mutations, 'delete');
      yield* mutations.processPendingOps();
      const row = (yield* localByTitle(listA(), temp.title))!;
      yield* mutations.deleteTask({
        accountId: LIVE_ACCOUNT_ID,
        taskId: row.id,
        taskListId: listA(),
      });
      yield* mutations.processPendingOps();
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
      yield* mutations.processPendingOps();
      const onGoogle = (yield* google.listTasks(listA())).filter(
        (task) => task.title === title && !task.deleted,
      );
      expect(onGoogle).toHaveLength(1);
      expect((yield* localByTitle(listA(), title))?.id).toBe(onGoogle[0]!.id);
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('moving a task to another list copies it there and deletes the source', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const temp = yield* create(mutations, 'move');
      yield* mutations.processPendingOps();
      const row = (yield* localByTitle(listA(), temp.title))!;
      yield* mutations.moveTask({
        accountId: LIVE_ACCOUNT_ID,
        draft: { dueDate: isoDay(1), title: temp.title },
        target: { accountId: LIVE_ACCOUNT_ID, taskListId: listB() },
        taskId: row.id,
        taskListId: listA(),
      });
      yield* mutations.processPendingOps();
      expect(yield* pendingOps).toEqual([]);
      const inB = (yield* google.listTasks(listB())).filter(
        (task) => task.title === temp.title && !task.deleted,
      );
      expect(inB).toHaveLength(1);
      const inA = (yield* google.listTasks(listA())).filter(
        (task) => task.title === temp.title && !task.deleted,
      );
      expect(inA).toHaveLength(0);
      expect((yield* localByTitle(listB(), temp.title))?.id).toBe(inB[0]!.id);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
