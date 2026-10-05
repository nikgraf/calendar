import { Attendee, CarriedText, EventRecord, GeoLocation, PendingOp } from '@calendar/core';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vitest';
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
      yield* repo.enqueue(
        op('op-1', {
          baseEtag: '"server"',
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
