import { Account, CalendarInfo, EventRecord, plainDateToUtcMs } from '@calendar/core';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { runMigrations } from './migrate.ts';
import { AccountRepo, CalendarRepo, EventRepo, reposLayer } from './repos.ts';

const freshDbLayer = () =>
  reposLayer.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

const account = new Account({
  createdAt: 1,
  email: 'nik@example.com',
  id: 'acc-1',
  status: 'ok',
});

const calendar = (overrides: Partial<CalendarInfo> = {}): CalendarInfo =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId: 'acc-1',
    colorHex: '#4285f4',
    id: 'cal-1',
    isPrimary: true,
    isVisible: true,
    summary: 'Personal',
    timeZone: 'Europe/Vienna',
    ...overrides,
  });

const timedEvent = (overrides: Partial<EventRecord> = {}): EventRecord =>
  new EventRecord({
    accountId: 'acc-1',
    calendarId: 'cal-1',
    endUtc: Date.parse('2026-07-02T13:00:00Z'),
    etag: '"e1"',
    id: 'evt-1',
    isAllDay: false,
    startTimeZone: 'Europe/Vienna',
    startUtc: Date.parse('2026-07-02T12:00:00Z'),
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title: 'Standup',
    updatedAt: 1,
    ...overrides,
  });

describe('repos', () => {
  it.effect('round-trips accounts', () =>
    Effect.gen(function* () {
      const repo = yield* AccountRepo;
      yield* repo.upsert(account);
      yield* repo.setStatus('acc-1', 'reauth_required');
      const listed = yield* repo.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.email).toBe('nik@example.com');
      expect(listed[0]!.status).toBe('reauth_required');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('preserves the local visibility toggle across upserts', () =>
    Effect.gen(function* () {
      const repo = yield* CalendarRepo;
      yield* repo.upsertMany([calendar()]);
      yield* repo.setVisible('acc-1', 'cal-1', false);
      // A later sync upserts the same calendar with fresh remote data.
      yield* repo.upsertMany([calendar({ summary: 'Personal (renamed)' })]);
      const listed = yield* repo.list('acc-1');
      expect(listed[0]!.summary).toBe('Personal (renamed)');
      expect(listed[0]!.isVisible).toBe(false);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('getWindow returns singles, masters, and overrides of visible calendars', () =>
    Effect.gen(function* () {
      const calendars = yield* CalendarRepo;
      const events = yield* EventRepo;
      yield* calendars.upsertMany([
        calendar(),
        calendar({ id: 'cal-hidden', isVisible: false, summary: 'Hidden' }),
      ]);

      const master = timedEvent({
        id: 'master-1',
        recurrence: ['RRULE:FREQ=WEEKLY'],
      });
      const override = timedEvent({
        endUtc: Date.parse('2026-07-09T16:00:00Z'),
        id: 'master-1__ovr',
        originalStartUtc: Date.parse('2026-07-09T12:00:00Z'),
        recurringEventId: 'master-1',
        startUtc: Date.parse('2026-07-09T15:00:00Z'),
      });
      const hiddenEvent = timedEvent({ calendarId: 'cal-hidden', id: 'evt-h' });
      yield* events.upsertMany([timedEvent(), master, override, hiddenEvent]);

      const window = yield* events.getWindow(
        Date.parse('2026-07-01T00:00:00Z'),
        Date.parse('2026-07-31T00:00:00Z'),
      );
      expect(window.singles.map((event) => event.id).sort()).toEqual(['evt-1', 'master-1__ovr']);
      expect(window.masters.map((event) => event.id)).toEqual(['master-1']);
      expect(window.overrides.map((event) => event.id)).toEqual(['master-1__ovr']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('deleteStale removes synced rows older than the pass', () =>
    Effect.gen(function* () {
      const calendars = yield* CalendarRepo;
      const events = yield* EventRepo;
      yield* calendars.upsertMany([calendar()]);
      yield* events.upsertMany([
        timedEvent({ id: 'old', syncedAt: 10 }),
        timedEvent({ id: 'fresh', syncedAt: 20 }),
        timedEvent({ id: 'pending-local', syncedAt: 5, syncStatus: 'pending' }),
      ]);
      yield* events.deleteStale('acc-1', 'cal-1', 15);
      const window = yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'));
      expect(window.singles.map((event) => event.id).sort()).toEqual(['fresh', 'pending-local']);
    }).pipe(Effect.provide(freshDbLayer())),
  );
});
