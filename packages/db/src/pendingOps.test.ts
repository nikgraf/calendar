import { Attendee, EventRecord, PendingOp } from '@calendar/core';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
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
      yield* repo.enqueue(
        op('op-1', { baseEtag: '"server"', colorHex: '#ff0000', lastError: 'boom', payload }),
      );

      const [stored] = yield* repo.listAll();
      expect(stored?.baseEtag).toBe('"server"');
      expect(stored?.colorHex).toBe('#ff0000');
      expect(stored?.lastError).toBe('boom');
      expect(stored?.payload?.title).toBe('Standup');
      expect(stored?.payload?.location).toBe('Room 1');
      expect(stored?.payload?.attendees?.[0]?.email).toBe('guest@example.com');
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

      yield* repo.removeForEvent('cal-1', 'evt-1');
      expect((yield* repo.listAll()).map((entry) => entry.id)).toEqual(['c']);
    }).pipe(Effect.provide(freshDbLayer())),
  );
});
