import {
  Attendee,
  CarriedText,
  EventRecord,
  GeoLocation,
  PendingOp,
  TaskRecord,
} from '@calendar/core';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import { runMigrations } from './migrate.ts';
import { PendingOpRepo, reposLayer } from './repos.ts';

const freshDbLayer = () =>
  reposLayer.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

const op = (id: string, overrides: Partial<PendingOp> = {}) =>
  new PendingOp({
    accountId: 'acc-1',
    attempts: 0,
    calendarId: 'cal-1',
    createdAt: 1,
    eventId: `evt-${id}`,
    id,
    kind: 'update',
    nextAttemptAt: 0,
    ...overrides,
  });

/** A synced event row titled `title`, the shape a snapshot holds. */
const eventRow = (title: string) =>
  new EventRecord({
    accountId: 'acc-1',
    calendarId: 'cal-1',
    endUtc: 2,
    etag: '"e"',
    id: 'evt-1',
    isAllDay: false,
    startUtc: 1,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
  });

/** An open task row titled `title`, the shape a task snapshot holds. */
const taskRow = (title: string) =>
  new TaskRecord({
    accountId: 'acc-1',
    id: 't-1',
    listId: 'list-1',
    provider: 'google',
    status: 'needsAction',
    title,
    updatedAt: 1,
  });

describe('PendingOpRepo', () => {
  it.effect('counts the ops waiting for a set of calendars and task lists', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('a'));
      yield* repo.enqueue(op('b', { calendarId: 'cal-2' }));
      yield* repo.enqueue(op('c', { kind: 'updateTask', taskListId: 'list-1' }));
      yield* repo.enqueue(op('d', { accountId: 'acc-2' }));
      const count = (calendarIds: Array<string>, taskListIds: Array<string>) =>
        repo.countFor('acc-1', { calendarIds, taskListIds });
      expect(yield* count(['cal-2'], [])).toBe(1);
      expect(yield* count([], ['list-1'])).toBe(1);
      expect(yield* count(['cal-1', 'cal-2'], ['list-1'])).toBe(3);
      expect(yield* count(['cal-9'], ['list-9'])).toBe(0);
      expect(yield* count([], [])).toBe(0);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('round-trips every optional field, payload included', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const payload = new EventRecord({
        accountId: 'acc-1',
        attendees: [new Attendee({ email: 'guest@example.com', responseStatus: 'needsAction' })],
        calendarId: 'cal-1',
        endUtc: 2,
        etag: '"e"',
        id: 'evt-1',
        isAllDay: false,
        location: 'Room 1',
        startUtc: 1,
        status: 'confirmed',
        syncedAt: 1,
        syncStatus: 'pending',
        title: 'Standup',
        updatedAt: 1,
      });
      const carriedText = new CarriedText({
        base: { description: null, location: 'Room 1', title: 'Daily' },
        overrides: [
          {
            etag: '"o-1"',
            eventId: 'evt-1_x',
            geo: new GeoLocation({ lat: 48.2, lng: 16.37, source: 'Stephansplatz 3, Wien' }),
            location: 'Stephansplatz 3, Wien',
            title: 'Daily (moved)',
          },
        ],
      });
      const beforeTask = new TaskRecord({
        accountId: 'acc-1',
        dueDate: '2026-08-30',
        id: 't-1',
        listId: 'list-1',
        provider: 'google',
        status: 'needsAction',
        title: 'Pay rent',
        updatedAt: 1,
      });
      yield* repo.enqueue(
        op('op-1', {
          baseEtag: '"server"',
          beforeColorHex: '#00ff00',
          beforeOverrides: [new EventRecord({ ...payload, id: 'evt-1_x', title: 'Moved' })],
          beforePayload: new EventRecord({ ...payload, title: 'Before' }),
          beforeTask,
          carriedText,
          colorHex: '#ff0000',
          lastError: 'boom',
          payload,
          remindersChanged: true,
        }),
      );

      const [stored] = yield* repo.listAll();
      expect(stored?.baseEtag).toBe('"server"');
      expect(stored?.remindersChanged).toBe(true);
      expect(stored?.colorHex).toBe('#ff0000');
      expect(stored?.lastError).toBe('boom');
      expect(stored?.payload?.title).toBe('Standup');
      expect(stored?.payload?.location).toBe('Room 1');
      expect(stored?.payload?.attendees?.[0]?.email).toBe('guest@example.com');
      expect(stored?.carriedText).toEqual(carriedText);
      expect(stored?.beforePayload?.title).toBe('Before');
      expect(stored?.beforeOverrides?.map((row) => row.title)).toEqual(['Moved']);
      expect(stored?.beforeTask).toEqual(beforeTask);
      expect(stored?.beforeColorHex).toBe('#00ff00');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('keeps "no row before" apart from "unknown" on the way through SQLite', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('none', { beforePayload: null }));
      yield* repo.enqueue(op('unknown'));
      const stored = Object.fromEntries(
        (yield* repo.listAll()).map((entry) => [entry.id, entry.beforePayload]),
      );
      expect(stored['none']).toBeNull();
      expect(stored['unknown']).toBeUndefined();
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('advanceBefore moves the snapshots of every op queued with a landed one', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const event = { accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-1' };
      yield* repo.enqueue(
        op('landed', { beforePayload: eventRow('A'), createdAt: 1, eventId: 'evt-1' }),
      );
      yield* repo.enqueue(
        op('earlier', { beforePayload: eventRow('A'), createdAt: 0, eventId: 'evt-1' }),
      );
      yield* repo.enqueue(
        op('after', { beforePayload: eventRow('A'), createdAt: 2, eventId: 'evt-1' }),
      );
      yield* repo.enqueue(op('legacy', { createdAt: 3, eventId: 'evt-1' }));
      yield* repo.enqueue(
        op('parked', {
          beforePayload: eventRow('A'),
          conflictAt: 5,
          createdAt: 4,
          eventId: 'evt-1',
        }),
      );
      yield* repo.enqueue(
        op('other', { beforePayload: eventRow('A'), createdAt: 5, eventId: 'evt-2' }),
      );
      yield* repo.advanceBefore(event, eventRow('B'), { id: 'landed' });
      const titles = Object.fromEntries(
        (yield* repo.listAll()).map((entry) => [entry.id, entry.beforePayload?.title]),
      );
      expect(titles).toEqual({
        after: 'B',
        // Queued before the landed op: it never held that change either.
        earlier: 'B',
        landed: 'A',
        legacy: 'B',
        other: 'A',
        parked: 'A',
      });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('advanceBeforeTask and setBefore replace one snapshot each way', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const taskOp = (id: string, kind: PendingOp['kind']) =>
        op(id, {
          beforeTask: taskRow('A'),
          calendarId: 'list-1',
          eventId: 't-1',
          kind,
          taskListId: 'list-1',
        });
      yield* repo.enqueue(taskOp('landed', 'updateTask'));
      yield* repo.enqueue(taskOp('toggle', 'completeTask'));
      yield* repo.enqueue(op('event', { beforePayload: eventRow('A'), eventId: 'evt-1' }));
      yield* repo.advanceBeforeTask(
        { accountId: 'acc-1', listId: 'list-1', taskId: 't-1' },
        taskRow('B'),
        { id: 'landed' },
      );
      yield* repo.setBefore('event', eventRow('C'));
      const stored = Object.fromEntries(
        (yield* repo.listAll()).map((entry) => [
          entry.id,
          entry.beforeTask?.title ?? entry.beforePayload?.title,
        ]),
      );
      expect(stored).toEqual({ event: 'C', landed: 'A', toggle: 'B' });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('forgetDeleted drops the snapshots of queued deletes of the deleted items', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const before = eventRow('A');
      yield* repo.enqueue(op('del', { beforePayload: before, eventId: 'evt-1', kind: 'delete' }));
      yield* repo.enqueue(op('upd', { beforePayload: before, eventId: 'evt-1', kind: 'update' }));
      yield* repo.enqueue(op('other', { beforePayload: before, eventId: 'evt-2', kind: 'delete' }));
      yield* repo.forgetDeleted('acc-1', 'cal-1', ['evt-1']);
      const kept = Object.fromEntries(
        (yield* repo.listAll()).map((entry) => [entry.id, entry.beforePayload !== undefined]),
      );
      expect(kept).toEqual({ del: false, other: true, upd: true });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('listDue hides ops whose backoff has not elapsed', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('ready', { nextAttemptAt: 1000 }));
      yield* repo.enqueue(op('waiting', { nextAttemptAt: 5000 }));

      expect((yield* repo.listDue(2000)).map((entry) => entry.id)).toEqual(['ready']);
      expect((yield* repo.listDue(9000)).map((entry) => entry.id).sort()).toEqual([
        'ready',
        'waiting',
      ]);
      // listAll ignores scheduling entirely.
      expect(yield* repo.listAll()).toHaveLength(2);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('a move survives content-edit coalescing and keeps its destination', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('upd', { eventId: 'evt-m' }));
      yield* repo.enqueue(
        op('mv', { createdAt: 2, eventId: 'evt-m', kind: 'move', targetCalendarId: 'cal-2' }),
      );
      yield* repo.removeForEvent('acc-1', 'cal-1', 'evt-m');

      const remaining = yield* repo.listAll();
      expect(remaining.map((entry) => entry.kind)).toEqual(['move']);
      expect(remaining[0]?.targetCalendarId).toBe('cal-2');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('earlierInSeries sees older ops for the series in any calendar', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const update = op('upd', { createdAt: 1, eventId: 'evt' });
      const instance = op('inst', { createdAt: 2, eventId: 'evt_20260714T090000Z' });
      const move = op('mv', { createdAt: 3, eventId: 'evt', kind: 'move' });
      const later = op('later', { calendarId: 'cal-2', createdAt: 4, eventId: 'evt' });
      yield* repo.enqueue(update);
      yield* repo.enqueue(instance);
      yield* repo.enqueue(move);
      yield* repo.enqueue(later);
      yield* repo.enqueue(op('other', { createdAt: 0, eventId: 'evt2' }));

      expect(yield* repo.earlierInSeries(update)).toEqual([]);
      expect(yield* repo.earlierInSeries(instance)).toEqual(['update']);
      expect(yield* repo.earlierInSeries(move)).toEqual(['update', 'update']);
      expect(yield* repo.earlierInSeries(later)).toEqual(['update', 'update', 'move']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('markFailed records the attempt, backoff and error', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('op-1'));
      yield* repo.markFailed('op-1', 3, 60_000, 'rate limited');

      const [stored] = yield* repo.listAll();
      expect(stored?.attempts).toBe(3);
      expect(stored?.nextAttemptAt).toBe(60_000);
      expect(stored?.lastError).toBe('rate limited');
      // Still queued, just not due yet.
      expect(yield* repo.listDue(59_999)).toHaveLength(0);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('remove and removeForEvent drop only what they target', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('a', { eventId: 'evt-1' }));
      yield* repo.enqueue(op('b', { eventId: 'evt-1', kind: 'delete' }));
      yield* repo.enqueue(op('c', { eventId: 'evt-2' }));

      yield* repo.remove('a');
      expect((yield* repo.listAll()).map((entry) => entry.id).sort()).toEqual(['b', 'c']);

      yield* repo.removeForEvent('acc-1', 'cal-1', 'evt-1');
      expect((yield* repo.listAll()).map((entry) => entry.id)).toEqual(['c']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('removeForEvent leaves another account on the same shared calendar alone', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('mine', { eventId: 'evt-1' }));
      yield* repo.enqueue(op('theirs', { accountId: 'acc-2', eventId: 'evt-1' }));
      yield* repo.removeForEvent('acc-1', 'cal-1', 'evt-1');
      expect((yield* repo.listAll()).map((entry) => entry.id)).toEqual(['theirs']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('advanceBaseEtag moves the followers built on the sent etag, not parked ones', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      // Queued before the op that landed (same instant, earlier row) and
      // long before: built without its change, so they keep their etag.
      yield* repo.enqueue(op('older', { baseEtag: '"v1"', createdAt: 0, eventId: 'evt-1' }));
      yield* repo.enqueue(op('tie', { baseEtag: '"v1"', eventId: 'evt-1' }));
      yield* repo.enqueue(op('landed', { baseEtag: '"v1"', eventId: 'evt-1' }));
      yield* repo.enqueue(op('same', { baseEtag: '"v1"', eventId: 'evt-1' }));
      yield* repo.enqueue(op('other', { baseEtag: '"v0"', eventId: 'evt-1' }));
      yield* repo.enqueue(op('parked', { baseEtag: '"v1"', eventId: 'evt-1' }));
      yield* repo.markConflict('parked', 5, undefined);
      yield* repo.enqueue(op('elsewhere', { baseEtag: '"v1"', eventId: 'evt-2' }));
      yield* repo.advanceBaseEtag(
        { accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-1' },
        '"v1"',
        '"v2"',
        { createdAt: 1, id: 'landed' },
      );
      const etags = Object.fromEntries(
        (yield* repo.listAll()).map((entry) => [entry.id, entry.baseEtag]),
      );
      expect(etags).toEqual({
        elsewhere: '"v1"',
        landed: '"v1"',
        older: '"v1"',
        other: '"v0"',
        parked: '"v1"',
        same: '"v2"',
        tie: '"v1"',
      });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('advanceBaseEtag after an op superseded in flight moves what shares its instant', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      // The landed op is gone: a later edit replaced it while it was sent.
      yield* repo.enqueue(op('replacement', { baseEtag: '"v1"', eventId: 'evt-1' }));
      yield* repo.advanceBaseEtag(
        { accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-1' },
        '"v1"',
        '"v2"',
        { createdAt: 1, id: 'superseded' },
      );
      expect((yield* repo.getById('replacement'))?.baseEtag).toBe('"v2"');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('listForEvent returns one event of one account, in queue order', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('second', { createdAt: 2, eventId: 'evt-1' }));
      yield* repo.enqueue(op('first', { createdAt: 1, eventId: 'evt-1' }));
      yield* repo.enqueue(op('other-account', { accountId: 'acc-2', eventId: 'evt-1' }));
      yield* repo.enqueue(op('other-calendar', { calendarId: 'cal-2', eventId: 'evt-1' }));
      yield* repo.enqueue(op('other-event', { eventId: 'evt-2' }));
      const ids = (yield* repo.listForEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: 'evt-1',
      })).map((entry) => entry.id);
      expect(ids).toEqual(['first', 'second']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('retryNow makes waiting ops due, per account or all, but not parked ones', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('a1', { attempts: 6, nextAttemptAt: 9000 }));
      yield* repo.enqueue(op('b1', { accountId: 'acc-2', nextAttemptAt: 9000 }));
      yield* repo.enqueue(op('parked', { nextAttemptAt: 9000 }));
      yield* repo.markConflict('parked', 5, undefined);

      yield* repo.retryNow('acc-1');
      expect((yield* repo.listDue(1)).map((entry) => entry.id)).toEqual(['a1']);
      // Attempts stay: the next failure backs off from where it was.
      expect((yield* repo.getById('a1'))?.attempts).toBe(6);

      yield* repo.retryNow();
      expect((yield* repo.listDue(1)).map((entry) => entry.id).sort()).toEqual(['a1', 'b1']);
    }).pipe(Effect.provide(freshDbLayer())),
  );
});
