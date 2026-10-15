import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { Account, PendingOp, TaskRecord } from '@calendar/core';
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
import { Clock, Effect, Layer, Scheduler } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';
import { FakeGoogle } from './testing/fakeGoogle.ts';

/**
 * Task order made elsewhere — another device's reorder, nest or un-nest,
 * and the renumbering every insert causes — reaches the app on the next
 * poll. Google bumps no task's `updated` for it, so the `updatedMin` pull
 * never brings it; the list's own `updated` moves, and the engine reads
 * the order when it does (all verified live, mirrored by the fake).
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

const MINUTE = 60_000;

const at = (n: number) => String(n).padStart(20, '0');

/** Trip ▸ Pack, Book, Visa · Rent · Party, in one list. */
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
  return google;
};

/**
 * The first pass, on an app clock ten minutes past the fake's stamps: the
 * later pulls' `updatedMin` leaves out what has not changed since. What
 * Google changes from here on is stamped after that watermark.
 */
const seed = (google: FakeGoogle) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(google.now + 10 * MINUTE);
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
    google.now = (yield* Clock.currentTimeMillis) + MINUTE;
  });

const poll = Effect.gen(function* () {
  yield* (yield* SyncEngine).syncAll();
});

/** One sibling group, in the order the inbox draws it (`parent` absent: the top level). */
const group = (parent?: string) =>
  Effect.gen(function* () {
    const rows = yield* (yield* TaskRepo).listSiblings('acc-1', 'list-1', parent);
    return rows.map((row) => row.id);
  });

/** Order-only listings of the list so far. */
const orderReads = (google: FakeGoogle) =>
  google.requests.filter(
    (call) =>
      call.method === 'GET' &&
      call.url.includes('/lists/list-1/tasks?') &&
      call.url.includes('fields='),
  ).length;

const ops = Effect.gen(function* () {
  return yield* (yield* PendingOpRepo).listAll();
});

describe('task order made elsewhere (Google)', () => {
  it.effect('another device’s reorder, nest and un-nest show on the next poll', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed(google);
      // The first pass listed the order with everything else.
      expect(orderReads(google)).toBe(0);
      expect(yield* group('trip')).toEqual(['pack', 'book', 'visa']);
      // Nothing moved: the list's `updated` stood still, no order read.
      yield* poll;
      expect(orderReads(google)).toBe(0);

      google.moveTaskServerSide('list-1', 'visa', { parent: 'trip' });
      yield* poll;
      expect(yield* group('trip')).toEqual(['visa', 'pack', 'book']);
      expect(orderReads(google)).toBe(1);

      google.moveTaskServerSide('list-1', 'rent', { parent: 'trip', previous: 'book' });
      yield* poll;
      expect(yield* group('trip')).toEqual(['visa', 'pack', 'book', 'rent']);
      expect(yield* group()).toEqual(['trip', 'party']);

      google.moveTaskServerSide('list-1', 'pack', { previous: 'trip' });
      yield* poll;
      expect(yield* group()).toEqual(['trip', 'pack', 'party']);
      expect(yield* group('trip')).toEqual(['visa', 'book', 'rent']);
      const rows = yield* (yield* TaskRepo).listSiblings('acc-1', 'list-1', undefined);
      expect(rows.map((row) => `${row.id}@${row.position}`)).toEqual([
        `trip@${at(0)}`,
        `pack@${at(1)}`,
        `party@${at(2)}`,
      ]);
      expect(orderReads(google)).toBe(3);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect(
    'an insert elsewhere goes first and shifts its siblings; a rename moves nothing',
    () => {
      const google = newGoogle();
      return Effect.gen(function* () {
        yield* seed(google);
        // Its "…00" would tie with Pack's old one; Pack is "…01" now.
        google.insertTaskServerSide('list-1', {
          id: 'tickets',
          parent: 'trip',
          status: 'needsAction',
          title: 'tickets',
        });
        yield* poll;
        expect(yield* group('trip')).toEqual(['tickets', 'pack', 'book', 'visa']);
        const pack = yield* (yield* TaskRepo).get('acc-1', 'list-1', 'pack');
        expect(pack?.position).toBe(at(1));
        expect(orderReads(google)).toBe(1);

        // A title edit leaves the list's `updated` alone: the pull brings it,
        // and there is no order to read.
        google.putTask('list-1', { ...google.taskOf('list-1', 'book')!, title: 'book flights' });
        yield* poll;
        expect((yield* (yield* TaskRepo).get('acc-1', 'list-1', 'book'))?.title).toBe(
          'book flights',
        );
        expect(orderReads(google)).toBe(1);
      }).pipe(noYield, Effect.provide(layerFor(google)));
    },
  );

  it.effect('a reorder still queued here is replayed over the order read', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed(google);
      const mutations = yield* EventMutations;
      // The move meets a 503 at the start of the poll and waits out its backoff.
      google.failTaskMoves = 1;
      yield* mutations.reorderTask({
        accountId: 'acc-1',
        parentId: 'trip',
        previousId: 'pack',
        taskId: 'visa',
        taskListId: 'list-1',
      });
      expect(yield* group('trip')).toEqual(['pack', 'visa', 'book']);
      google.insertTaskServerSide('list-1', {
        id: 'tickets',
        parent: 'trip',
        status: 'needsAction',
        title: 'tickets',
      });
      yield* poll;
      const [queued] = yield* ops;
      expect(queued).toMatchObject({ attempts: 1, eventId: 'visa', kind: 'reorderTask' });
      // Google's order, with the queued reorder placed over it again.
      expect(yield* group('trip')).toEqual(['tickets', 'pack', 'visa', 'book']);
      // A discard would put Visa back where Google has it now.
      expect(queued?.beforeTask?.position).toBe(at(3));

      yield* TestClock.adjust('1 hour');
      yield* mutations.processPendingOps();
      expect(yield* ops).toEqual([]);
      expect(yield* group('trip')).toEqual(['tickets', 'pack', 'visa', 'book']);
      expect(google.taskOf('list-1', 'visa')?.position).toBe(at(2));
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });

  it.effect('a subtask created here sorts first once it lands, as Google put it', () => {
    const google = newGoogle();
    return Effect.gen(function* () {
      yield* seed(google);
      const now = yield* Clock.currentTimeMillis;
      // What a move carrying subtasks along queues: a temp row and its create.
      yield* (yield* TaskRepo).insertLocal(
        new TaskRecord({
          accountId: 'acc-1',
          id: 'local-tickets',
          listId: 'list-1',
          parentId: 'trip',
          provider: 'google',
          status: 'needsAction',
          title: 'tickets',
          updatedAt: now,
        }),
      );
      yield* (yield* PendingOpRepo).enqueue(
        new PendingOp({
          accountId: 'acc-1',
          attempts: 0,
          calendarId: 'list-1',
          createdAt: now,
          eventId: 'local-tickets',
          id: 'op-tickets',
          kind: 'createTask',
          nextAttemptAt: 0,
          taskListId: 'list-1',
          taskParent: 'trip',
          taskTitle: 'tickets',
        }),
      );
      yield* (yield* EventMutations).processPendingOps();
      const [created] = (yield* group('trip')).filter((id) => id.startsWith('task-'));
      expect(google.taskOf('list-1', created!)?.position).toBe(at(0));
      // Pack still holds Google's old "…00" here, yet the new one sorts first.
      expect(yield* group('trip')).toEqual([created, 'pack', 'book', 'visa']);

      // The next poll reads the renumbered order back.
      yield* poll;
      const rows = yield* (yield* TaskRepo).listSubtasks('acc-1', 'list-1', 'trip');
      expect(rows.map((row) => `${row.id}@${row.position}`)).toEqual([
        `${created}@${at(0)}`,
        `pack@${at(1)}`,
        `book@${at(2)}`,
        `visa@${at(3)}`,
      ]);
    }).pipe(noYield, Effect.provide(layerFor(google)));
  });
});
