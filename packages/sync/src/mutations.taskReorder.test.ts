import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { Account, APPLE_REMINDERS_ACCOUNT_ID, TaskListInfo, TaskRecord } from '@calendar/core';
import { AccountRepo, PendingOpRepo, reposLayer, runMigrations, TaskRepo } from '@calendar/db';
import {
  GoogleCalendarClient,
  GooglePeopleClient,
  GoogleTasksClient,
  type GcalTask,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer, Scheduler } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';
import { FakeGoogle } from './testing/fakeGoogle.ts';

/**
 * Reordering and re-nesting Google tasks inside their list (`reorderTask`)
 * against the in-process fake API, which renumbers siblings the way Google
 * does (20-digit ordinals, no `updated` bump — verified live).
 */

// Queue assertions run before the detached drain gets a turn.
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

const layerFor = (google: FakeGoogle) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(GoogleCalendarClient.layer),
    Layer.provideMerge(GoogleTasksClient.layer),
    Layer.provideMerge(GooglePeopleClient.layer),
    Layer.provideMerge(google.layer),
  );

const at = (n: number) => String(n).padStart(20, '0');

/**
 * Trip ▸ Pack, Book, Visa · Rent · Party ▸ Cake, in one list. Rent and Party
 * sit at the top level after Trip.
 */
const newGoogle = () => {
  const google = new FakeGoogle({
    calendars: [{ accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' }],
    taskLists: [{ id: 'list-1', title: 'My Tasks' }],
  });
  const put = (id: string, position: number, parent?: string) =>
    google.putTask('list-1', {
      id,
      ...(parent === undefined ? {} : { parent }),
      position: at(position),
      status: 'needsAction',
      title: id,
    } satisfies GcalTask);
  put('trip', 0);
  put('pack', 0, 'trip');
  put('book', 1, 'trip');
  put('visa', 2, 'trip');
  put('rent', 1);
  put('party', 2);
  put('cake', 0, 'party');
  return google;
};

const seed = Effect.gen(function* () {
  yield* (yield* AccountRepo).upsert(
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'nik@example.com',
      id: 'acc-1',
      provider: 'google',
      status: 'ok',
      tasksEnabled: true,
    }),
  );
  yield* (yield* SyncEngine).syncAll();
});

/** One sibling group, in the order the inbox draws it (`parent` absent: the top level). */
const group = (parent?: string) =>
  Effect.gen(function* () {
    const rows = yield* (yield* TaskRepo).listSiblings('acc-1', 'list-1', parent);
    return rows.map((row) => row.id);
  });

/** Google's own order for the same group. */
const googleGroup = (google: FakeGoogle, ids: ReadonlyArray<string>, parent?: string) =>
  ids
    .map((id) => google.taskOf('list-1', id))
    .filter(
      (task): task is GcalTask =>
        task !== undefined && task.deleted !== true && task.parent === parent,
    )
    .sort((a, b) => (a.position ?? '').localeCompare(b.position ?? ''))
    .map((task) => task.id);

const ALL = ['trip', 'pack', 'book', 'visa', 'rent', 'party', 'cake'];

const reorder = (taskId: string, place: { parentId?: string; previousId?: string }) =>
  Effect.gen(function* () {
    const mutations = yield* EventMutations;
    return yield* mutations.reorderTask({
      accountId: 'acc-1',
      taskId,
      taskListId: 'list-1',
      ...place,
    });
  });

const drain = Effect.gen(function* () {
  yield* TestClock.adjust('1 hour');
  yield* (yield* EventMutations).processPendingOps();
});

const ops = Effect.gen(function* () {
  return yield* (yield* PendingOpRepo).listAll();
});

describe('reorderTask (Google)', () => {
  it.effect('a subtask moves among its siblings at once, and Google agrees once it lands', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      expect(yield* group('trip')).toEqual(['pack', 'book', 'visa']);

      yield* reorder('visa', { parentId: 'trip', previousId: 'pack' });
      // Drawn where it was dropped before anything is sent.
      expect(yield* group('trip')).toEqual(['pack', 'visa', 'book']);
      const [queued] = yield* ops;
      expect(queued).toMatchObject({
        eventId: 'visa',
        kind: 'reorderTask',
        taskParent: 'trip',
        taskPrevious: 'pack',
      });
      expect(queued?.beforeTask?.position).toBe(at(2));

      yield* drain;
      expect(googleGroup(google, ALL, 'trip')).toEqual(['pack', 'visa', 'book']);
      // Google renumbered the group and bumped no `updated`: no pull would
      // bring that, so the list's order was read back.
      const rows = yield* (yield* TaskRepo).listSubtasks('acc-1', 'list-1', 'trip');
      expect(rows.map((row) => `${row.id}@${row.position}`)).toEqual([
        `pack@${at(0)}`,
        `visa@${at(1)}`,
        `book@${at(2)}`,
      ]);
      expect(yield* ops).toEqual([]);
      const read = google.requests.filter(
        (call) => call.method === 'GET' && call.url.includes('/lists/list-1/tasks?'),
      );
      expect(read.at(-1)?.url).not.toContain('updatedMin=');
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('nests a task under another and takes a subtask out, right after its parent', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      yield* reorder('rent', { parentId: 'trip', previousId: 'visa' });
      yield* reorder('cake', { previousId: 'party' });
      expect(yield* group('trip')).toEqual(['pack', 'book', 'visa', 'rent']);
      expect(yield* group()).toEqual(['trip', 'party', 'cake']);
      yield* drain;
      expect(googleGroup(google, ALL, 'trip')).toEqual(['pack', 'book', 'visa', 'rent']);
      expect(googleGroup(google, ALL)).toEqual(['trip', 'party', 'cake']);
      expect(google.taskOf('list-1', 'cake')?.parent).toBeUndefined();
      expect(yield* group('trip')).toEqual(['pack', 'book', 'visa', 'rent']);
      expect(yield* group()).toEqual(['trip', 'party', 'cake']);
      expect(yield* ops).toEqual([]);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('a second reorder is placed against the first, and both land in that order', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      // Visa first, then Book right after it.
      yield* reorder('visa', { parentId: 'trip' });
      yield* reorder('book', { parentId: 'trip', previousId: 'visa' });
      expect(yield* group('trip')).toEqual(['visa', 'book', 'pack']);
      yield* drain;
      expect(googleGroup(google, ALL, 'trip')).toEqual(['visa', 'book', 'pack']);
      expect(yield* group('trip')).toEqual(['visa', 'book', 'pack']);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('keeps Google Tasks one level deep', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      const refused = (taskId: string, parentId: string) =>
        Effect.map(Effect.flip(reorder(taskId, { parentId })), (error) => error._tag);
      // A task with subtasks under another; a task under a subtask; under itself.
      expect(yield* refused('party', 'trip')).toBe('TaskHierarchyError');
      expect(yield* refused('rent', 'pack')).toBe('TaskHierarchyError');
      expect(yield* refused('rent', 'rent')).toBe('TaskHierarchyError');
      // A sibling that is not one under that parent.
      expect(
        (yield* Effect.flip(reorder('rent', { parentId: 'trip', previousId: 'cake' })))._tag,
      ).toBe('TaskNotFoundError');
      expect(yield* ops).toEqual([]);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('a task Google has not created yet is not placed, nor placed under', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      // Held back: the create stays queued with its temp id.
      const fresh = yield* mutations.createTask({
        accountId: 'acc-1',
        taskListId: 'list-1',
        title: 'Fresh',
      });
      expect((yield* Effect.flip(reorder(fresh.id, { parentId: 'trip' })))._tag).toBe(
        'TaskCreatePendingError',
      );
      expect((yield* Effect.flip(reorder('rent', { parentId: fresh.id })))._tag).toBe(
        'TaskCreatePendingError',
      );
      // After it, at the top level: after the last task Google has numbered.
      yield* reorder('trip', { previousId: fresh.id });
      const queued = (yield* ops).find((op) => op.kind === 'reorderTask');
      expect(queued?.taskPrevious).toBe('party');
      expect(yield* group()).toEqual(['rent', 'party', 'trip', fresh.id]);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('a reorder to where the task already is sends nothing', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      yield* reorder('book', { parentId: 'trip', previousId: 'pack' });
      yield* reorder('pack', { parentId: 'trip' });
      expect(yield* ops).toEqual([]);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('Reminders have no order or subtasks through EventKit', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      yield* (yield* AccountRepo).upsert(
        new Account({
          contactsEnabled: false,
          createdAt: 1,
          email: '',
          id: APPLE_REMINDERS_ACCOUNT_ID,
          provider: 'apple',
          status: 'ok',
          tasksEnabled: true,
        }),
      );
      const tasks = yield* TaskRepo;
      yield* tasks.upsertLists(
        [
          new TaskListInfo({
            accountId: APPLE_REMINDERS_ACCOUNT_ID,
            id: 'ek',
            isVisible: true,
            provider: 'apple',
            title: 'Reminders',
          }),
        ],
        1,
      );
      yield* tasks.upsertTasks(
        ['a', 'b'].map(
          (id) =>
            new TaskRecord({
              accountId: APPLE_REMINDERS_ACCOUNT_ID,
              id,
              listId: 'ek',
              provider: 'apple',
              status: 'needsAction',
              title: id,
              updatedAt: 1,
            }),
        ),
        1,
      );
      const mutations = yield* EventMutations;
      const error = yield* Effect.flip(
        mutations.reorderTask({
          accountId: APPLE_REMINDERS_ACCOUNT_ID,
          parentId: 'a',
          taskId: 'b',
          taskListId: 'ek',
        }),
      );
      expect(error).toMatchObject({ _tag: 'UnsupportedForProviderError', provider: 'apple' });
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('discarding the later of two reorders puts back the earlier one’s place', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const tasks = yield* TaskRepo;
      yield* reorder('rent', { parentId: 'trip', previousId: 'pack' });
      yield* reorder('rent', { parentId: 'party' });
      const [first, second] = yield* ops;
      yield* mutations.discardPendingOp(second!.id);
      // Back under Trip after Pack, the first reorder untouched.
      expect(yield* group('trip')).toEqual(['pack', 'rent', 'book', 'visa']);
      expect((yield* ops).map((op) => [op.id, op.beforeTask?.parentId])).toEqual([
        [first!.id, undefined],
      ]);
      yield* mutations.discardPendingOp(first!.id);
      const rent = yield* tasks.get('acc-1', 'list-1', 'rent');
      expect([rent?.parentId, rent?.position]).toEqual([undefined, at(1)]);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('a landed reorder rebases what a queued one would put back', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      // Visa first under Trip — Google renumbers: Book goes from 1 to 2.
      yield* reorder('visa', { parentId: 'trip' });
      // Book under Party after Cake, which Google deleted meanwhile: a 400.
      yield* reorder('book', { parentId: 'party', previousId: 'cake' });
      google.deleteTaskServerSide('list-1', 'cake');
      yield* drain;
      expect(yield* ops).toEqual([]);
      expect(googleGroup(google, ALL, 'trip')).toEqual(['visa', 'pack', 'book']);
      // Book is back where Google has it now, not at its old position 1.
      expect(yield* group('trip')).toEqual(['visa', 'pack', 'book']);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('a discarded reorder puts the task back; one queued behind it takes over', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const tasks = yield* TaskRepo;
      yield* reorder('rent', { parentId: 'trip', previousId: 'pack' });
      yield* reorder('rent', { parentId: 'party' });
      const [first, second] = yield* ops;
      // The first will not happen: the second still owns the row, and its
      // own discard must now restore the place Google has.
      yield* mutations.discardPendingOp(first!.id);
      expect((yield* tasks.get('acc-1', 'list-1', 'rent'))?.parentId).toBe('party');
      expect((yield* ops)[0]?.beforeTask?.parentId).toBeUndefined();
      yield* mutations.discardPendingOp(second!.id);
      const rent = yield* tasks.get('acc-1', 'list-1', 'rent');
      expect([rent?.parentId, rent?.position]).toEqual([undefined, at(1)]);
      expect(yield* group()).toEqual(['trip', 'rent', 'party']);
      expect(yield* ops).toEqual([]);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('Google refusing the place, or no longer having the task, puts it back', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      const tasks = yield* TaskRepo;
      // Elsewhere, Pack left Trip: "after Pack under Trip" is a 400 now.
      google.putTask('list-1', {
        id: 'pack',
        position: at(3),
        status: 'needsAction',
        title: 'pack',
      });
      yield* reorder('visa', { parentId: 'trip', previousId: 'pack' });
      yield* drain;
      expect(yield* ops).toEqual([]);
      const visa = yield* tasks.get('acc-1', 'list-1', 'visa');
      expect([visa?.parentId, visa?.position]).toEqual(['trip', at(2)]);
      // Deleted on Google meanwhile: a 404, the row back where it was until
      // the pull's tombstone takes it.
      google.deleteTaskServerSide('list-1', 'rent');
      yield* reorder('rent', { parentId: 'trip', previousId: 'visa' });
      yield* drain;
      expect(yield* ops).toEqual([]);
      expect((yield* tasks.get('acc-1', 'list-1', 'rent'))?.parentId).toBeUndefined();
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('waits for what was queued before it in its list; a delete behind it waits too', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      // The move meets a 503 first and waits out its backoff.
      google.failTaskMoves = 1;
      yield* reorder('visa', { parentId: 'trip', previousId: 'pack' });
      yield* mutations.processPendingOps();
      expect((yield* ops)[0]?.attempts).toBe(1);
      // Pack's delete would take the sibling the move names: it waits.
      yield* mutations.deleteTask({ accountId: 'acc-1', taskId: 'pack', taskListId: 'list-1' });
      yield* mutations.processPendingOps();
      expect(google.taskOf('list-1', 'pack')?.deleted).toBeUndefined();
      expect((yield* ops).map((op) => op.kind)).toEqual(['reorderTask', 'deleteTask']);
      expect((yield* ops)[1]?.lastError).toBe('waiting for the reorder ahead of it');
      yield* drain;
      expect(yield* ops).toEqual([]);
      expect(googleGroup(google, ALL, 'trip')).toEqual(['visa', 'book']);
      expect(google.taskOf('list-1', 'pack')?.deleted).toBe(true);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('a task does not move to another list while a reorder involving it is queued', () => {
    const google = new FakeGoogle({
      calendars: [{ accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' }],
      taskLists: [
        { id: 'list-1', title: 'My Tasks' },
        { id: 'list-2', title: 'Errands' },
      ],
    });
    for (const [id, position] of [
      ['trip', 0],
      ['rent', 1],
      ['party', 2],
    ] as const) {
      google.putTask('list-1', {
        due: '2026-08-30T00:00:00.000Z',
        id,
        position: at(position),
        status: 'needsAction',
        title: id,
      });
    }
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const move = (taskId: string) =>
        mutations.moveTask({
          accountId: 'acc-1',
          draft: { dueDate: '2026-08-30', title: taskId },
          target: { accountId: 'acc-1', taskListId: 'list-2' },
          taskId,
          taskListId: 'list-1',
        });
      // Rent nested under Trip, not yet on Google: which tasks Trip takes
      // along is not settled, and neither is where Rent is.
      yield* reorder('rent', { parentId: 'trip' });
      expect((yield* Effect.flip(move('trip')))._tag).toBe('TaskCreatePendingError');
      expect((yield* Effect.flip(move('rent')))._tag).toBe('TaskCreatePendingError');
      // An unrelated task moves.
      yield* move('party');
      yield* drain;
      expect(yield* ops).toEqual([]);
      // Landed: now Trip takes Rent along.
      yield* move('trip');
      yield* drain;
      expect(google.taskOf('list-2', 'rent')?.parent).toBe('trip');
      expect((yield* (yield* TaskRepo).get('acc-1', 'list-2', 'rent'))?.parentId).toBe('trip');
      expect(yield* ops).toEqual([]);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('a refused reparent keeps the parent whose delete would take the task along', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const tasks = yield* TaskRepo;
      // Pack leaves Trip for Party (after Cake, which Google deleted
      // meanwhile: a 400); then Trip is deleted with what is still under it.
      yield* reorder('pack', { parentId: 'party', previousId: 'cake' });
      google.deleteTaskServerSide('list-1', 'cake');
      yield* mutations.deleteTask({ accountId: 'acc-1', taskId: 'trip', taskListId: 'list-1' });
      yield* drain;
      expect(yield* ops).toEqual([]);
      // Pack is back under Trip, so Trip stays — on Google too, with Pack.
      expect(google.taskOf('list-1', 'trip')?.deleted).toBeUndefined();
      expect(google.taskOf('list-1', 'pack')).toMatchObject({ parent: 'trip' });
      expect(google.taskOf('list-1', 'pack')?.deleted).toBeUndefined();
      expect((yield* tasks.get('acc-1', 'list-1', 'trip'))?.title).toBe('trip');
      expect((yield* tasks.get('acc-1', 'list-1', 'pack'))?.parentId).toBe('trip');
      // The subtasks that went with Trip's delete are gone as asked.
      expect(google.taskOf('list-1', 'book')?.deleted).toBe(true);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('an edit landing between two queued reorders leaves their places alone', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      // Both reorders wait (the first meets a 503); the rename lands.
      google.failTaskMoves = 1;
      yield* reorder('rent', { parentId: 'trip', previousId: 'pack' });
      yield* reorder('rent', { parentId: 'party' });
      yield* mutations.updateTask({
        accountId: 'acc-1',
        changes: { title: 'Rent!' },
        taskId: 'rent',
        taskListId: 'list-1',
      });
      yield* mutations.processPendingOps();
      expect(google.taskOf('list-1', 'rent')?.title).toBe('Rent!');
      const second = (yield* ops).filter((op) => op.kind === 'reorderTask')[1];
      // Discarding the second puts back the first one's place, not Google's.
      yield* mutations.discardPendingOp(second!.id);
      expect(yield* group('trip')).toEqual(['pack', 'rent', 'book', 'visa']);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('a task is not placed while a move to another list involving it is queued', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      // A second list, and Trip on its way there (held back by a 503).
      yield* (yield* TaskRepo).upsertLists(
        [
          new TaskListInfo({
            accountId: 'acc-1',
            id: 'list-2',
            isVisible: true,
            provider: 'google',
            title: 'Errands',
          }),
        ],
        1,
      );
      google.failTaskMoves = 1;
      yield* mutations.moveTask({
        accountId: 'acc-1',
        draft: { dueDate: '', title: 'trip' },
        target: { accountId: 'acc-1', taskListId: 'list-2' },
        taskId: 'trip',
        taskListId: 'list-1',
      });
      yield* mutations.processPendingOps();
      // Pack went along under Trip; taking it out there waits for the move.
      const outdent = yield* Effect.flip(
        mutations.reorderTask({
          accountId: 'acc-1',
          previousId: 'trip',
          taskId: 'pack',
          taskListId: 'list-2',
        }),
      );
      expect(outdent._tag).toBe('TaskCreatePendingError');
      // So does nesting a task of the old list under it, by the old list's id.
      expect((yield* Effect.flip(reorder('rent', { previousId: 'trip' })))._tag).toBe(
        'TaskCreatePendingError',
      );
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('a nest an undone outdent made two levels deep is dropped as it is sent', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const tasks = yield* TaskRepo;
      // Cake out of Party; Party (no subtasks now) under Trip; then Cake's
      // outdent is discarded and Cake is back under Party.
      yield* reorder('cake', { previousId: 'party' });
      yield* reorder('party', { parentId: 'trip', previousId: 'visa' });
      const [outdent] = yield* ops;
      yield* mutations.discardPendingOp(outdent!.id);
      yield* drain;
      expect(yield* ops).toEqual([]);
      // Nothing two levels deep on Google; Party back at the top here too.
      expect(google.taskOf('list-1', 'party')?.parent).toBeUndefined();
      expect(google.taskOf('list-1', 'cake')?.parent).toBe('party');
      expect((yield* tasks.get('acc-1', 'list-1', 'party'))?.parentId).toBeUndefined();
      expect(yield* group('trip')).toEqual(['pack', 'book', 'visa']);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect(
    'the read-back reaches rows with other changes queued, and replays queued reorders',
    () => {
      const google = newGoogle();
      return Effect.gen(function* () {
        yield* seed;
        const mutations = yield* EventMutations;
        // Visa first; Pack renamed (held back by a 503); then Book right after
        // Visa, which waits behind the rename.
        yield* reorder('visa', { parentId: 'trip' });
        google.failTaskPatches = 1;
        yield* mutations.updateTask({
          accountId: 'acc-1',
          changes: { title: 'Pack!' },
          taskId: 'pack',
          taskListId: 'list-1',
        });
        yield* reorder('book', { parentId: 'trip', previousId: 'visa' });
        expect(yield* group('trip')).toEqual(['visa', 'book', 'pack']);
        yield* mutations.processPendingOps();
        expect((yield* ops).map((op) => `${op.kind}:${op.eventId}`)).toEqual([
          'updateTask:pack',
          'reorderTask:book',
        ]);
        // Google has Visa, Pack, Book: Pack takes Google's place despite its
        // queued rename, and Book's queued reorder is replayed over it.
        expect(yield* group('trip')).toEqual(['visa', 'book', 'pack']);
        // Without the rename, Pack stays where Google has it.
        const [rename] = yield* ops;
        yield* mutations.discardPendingOp(rename!.id);
        expect(yield* group('trip')).toEqual(['visa', 'book', 'pack']);
        yield* drain;
        expect(yield* ops).toEqual([]);
        expect(googleGroup(google, ALL, 'trip')).toEqual(['visa', 'book', 'pack']);
        expect(yield* group('trip')).toEqual(['visa', 'book', 'pack']);
      }).pipe(noYield, Effect.provide(layerFor(google)));
    },
  );
});
