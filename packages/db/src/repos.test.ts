import {
  Account,
  CalendarInfo,
  EventRecord,
  EventReminders,
  GeoLocation,
  plainDateToUtcMs,
  ReminderOverride,
  SyncState,
} from '@calendar/core';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { EVENTS_KEY } from './keys.ts';
import { runMigrations } from './migrate.ts';
import { AccountRepo, CalendarRepo, EventRepo, reposLayer, SyncStateRepo } from './repos.ts';

/** Mirror rows are only written while their account exists — seed the ones tests use. */
const seedAccounts = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  for (const id of ['acc-1', 'acc-2']) {
    yield* accounts.upsert(
      new Account({
        contactsEnabled: false,
        createdAt: 1,
        email: `${id}@example.com`,
        id,
        provider: 'google',
        status: 'ok',
        tasksEnabled: true,
      }),
    );
  }
});

const freshDbLayer = () =>
  Layer.effectDiscard(seedAccounts).pipe(
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

const account = new Account({
  contactsEnabled: false,
  createdAt: 1,
  email: 'nik@example.com',
  id: 'acc-1',
  provider: 'google',
  status: 'ok',
  tasksEnabled: false,
});

const calendar = (overrides: Partial<CalendarInfo> = {}): CalendarInfo =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId: 'acc-1',
    colorHex: '#4285f4',
    id: 'cal-1',
    isPrimary: true,
    isVisible: true,
    provider: 'google',
    summary: 'Personal',
    timeZone: 'Europe/Vienna',
    ...overrides,
  });

const syncState = (scope: string, syncToken: string | null, status: SyncState['status']) =>
  new SyncState({
    accountId: 'acc-1',
    lastFullSyncAt: null,
    lastSyncAt: 1,
    scope,
    status,
    syncToken,
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
      const listed = (yield* repo.list()).find((candidate) => candidate.id === 'acc-1');
      expect(listed?.email).toBe('nik@example.com');
      expect(listed?.status).toBe('reauth_required');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('rows and sync state are never written for a removed account', () =>
    Effect.gen(function* () {
      // A sync pass that finishes after the user removed the account must
      // not recreate what remove() deleted — later passes would never
      // touch those rows again.
      const accounts = yield* AccountRepo;
      const calendars = yield* CalendarRepo;
      const events = yield* EventRepo;
      const syncState = yield* SyncStateRepo;
      yield* calendars.upsertMany([calendar()]);
      yield* events.upsertMany([timedEvent()]);
      yield* accounts.remove('acc-1');
      yield* calendars.upsertMany([calendar()]);
      yield* events.upsertMany([timedEvent()]);
      yield* syncState.set(
        new SyncState({
          accountId: 'acc-1',
          lastFullSyncAt: 1,
          lastSyncAt: 1,
          scope: 'calendars',
          status: 'idle',
          syncToken: 'tok',
        }),
      );
      expect(yield* calendars.list('acc-1')).toEqual([]);
      expect((yield* events.getWindow(0, Number.MAX_SAFE_INTEGER)).singles).toEqual([]);
      expect(yield* syncState.get('acc-1', 'calendars')).toBeNull();
      // The other account is untouched by the guard.
      yield* calendars.upsertMany([calendar({ accountId: 'acc-2' })]);
      expect(yield* calendars.list('acc-2')).toHaveLength(1);
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

  it.effect("lists a calendar's provider from its account and keeps its source title", () =>
    Effect.gen(function* () {
      const accounts = yield* AccountRepo;
      const repo = yield* CalendarRepo;
      yield* accounts.upsert(
        new Account({
          ...account,
          displayName: 'Apple Calendar',
          email: '',
          id: 'apple-calendar',
          provider: 'apple',
        }),
      );
      yield* repo.upsertMany([
        calendar({
          accountId: 'apple-calendar',
          id: 'ek-1',
          provider: 'apple',
          sourceTitle: 'iCloud',
        }),
      ]);
      yield* repo.upsertMany([calendar()]);
      const byId = new Map((yield* repo.list()).map((entry) => [entry.id, entry]));
      expect(byId.get('ek-1')?.provider).toBe('apple');
      expect(byId.get('ek-1')?.sourceTitle).toBe('iCloud');
      expect(byId.get('cal-1')?.provider).toBe('google');
      expect(byId.get('cal-1')?.sourceTitle).toBeUndefined();
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

  it.effect('persists and clears event coordinates', () =>
    Effect.gen(function* () {
      const calendars = yield* CalendarRepo;
      const events = yield* EventRepo;
      yield* calendars.upsertMany([calendar()]);
      const geo = new GeoLocation({ lat: 48.2, lng: 16.37, source: 'Naschmarkt' });
      yield* events.upsertMany([timedEvent({ geo, location: 'Naschmarkt' })]);
      expect((yield* events.getById('acc-1', 'cal-1', 'evt-1'))?.geo).toEqual(geo);

      yield* events.upsertMany([timedEvent({ location: 'Office' })]);
      expect((yield* events.getById('acc-1', 'cal-1', 'evt-1'))?.geo).toBeUndefined();
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('persists event reminders and calendar defaults', () =>
    Effect.gen(function* () {
      const calendars = yield* CalendarRepo;
      const events = yield* EventRepo;
      const defaults = [new ReminderOverride({ method: 'popup', minutes: 10 })];
      yield* calendars.upsertMany([calendar({ defaultReminders: defaults })]);
      expect((yield* calendars.list('acc-1'))[0]?.defaultReminders).toEqual(defaults);
      const none = new EventReminders({ overrides: [], useDefault: false });
      yield* events.upsertMany([timedEvent({ reminders: none })]);
      expect((yield* events.getById('acc-1', 'cal-1', 'evt-1'))?.reminders).toEqual(none);
      yield* events.upsertMany([timedEvent()]);
      expect((yield* events.getById('acc-1', 'cal-1', 'evt-1'))?.reminders).toBeUndefined();
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect("overrides are scoped to their master's account and calendar", () =>
    Effect.gen(function* () {
      const calendars = yield* CalendarRepo;
      const events = yield* EventRepo;
      // Event ids are Google-global: two accounts subscribed to one
      // shared calendar hold masters with identical ids, and a hidden
      // calendar can carry the same series too.
      yield* calendars.upsertMany([
        calendar({ id: 'shared', summary: 'Team' }),
        calendar({ accountId: 'acc-2', id: 'shared', summary: 'Team' }),
        calendar({ id: 'cal-hidden', isVisible: false, summary: 'Hidden' }),
      ]);
      const series = (overrides: Partial<EventRecord>) =>
        timedEvent({ id: 'master-1', recurrence: ['RRULE:FREQ=WEEKLY'], ...overrides });
      const exception = (overrides: Partial<EventRecord>) =>
        timedEvent({
          endUtc: Date.parse('2026-07-09T16:00:00Z'),
          id: 'master-1__ovr',
          originalStartUtc: Date.parse('2026-07-09T12:00:00Z'),
          recurringEventId: 'master-1',
          startUtc: Date.parse('2026-07-09T15:00:00Z'),
          ...overrides,
        });
      yield* events.upsertMany([
        series({ calendarId: 'shared' }),
        series({ accountId: 'acc-2', calendarId: 'shared' }),
        series({ calendarId: 'cal-hidden' }),
        // Only the second account moved its occurrence.
        exception({ accountId: 'acc-2', calendarId: 'shared' }),
        exception({ calendarId: 'cal-hidden' }),
      ]);

      const window = yield* events.getWindow(
        Date.parse('2026-07-01T00:00:00Z'),
        Date.parse('2026-07-31T00:00:00Z'),
      );
      expect(window.masters.map((event) => event.accountId).sort()).toEqual(['acc-1', 'acc-2']);
      expect(
        window.overrides.map((event) => `${event.accountId}/${event.calendarId}/${event.id}`),
      ).toEqual(['acc-2/shared/master-1__ovr']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('event mutations invalidate the coarse events key', () =>
    Effect.gen(function* () {
      const calendars = yield* CalendarRepo;
      const events = yield* EventRepo;
      const reactivity = yield* Reactivity;
      let invalidations = 0;
      reactivity.registerUnsafe([EVENTS_KEY], () => {
        invalidations += 1;
      });

      yield* calendars.upsertMany([calendar()]);
      expect(invalidations).toBe(0); // calendar upserts don't touch events

      yield* events.upsertMany([timedEvent()]);
      yield* calendars.setVisible('acc-1', 'cal-1', false);
      yield* events.deleteEvent('acc-1', 'cal-1', 'evt-1');
      // Consecutive invalidations may coalesce within a scheduler tick; the
      // guarantee is that event/visibility mutations reach EVENTS_KEY at all.
      expect(invalidations).toBeGreaterThanOrEqual(2);
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

  it.effect('getWindow skips series that ended before the range', () =>
    Effect.gen(function* () {
      const calendars = yield* CalendarRepo;
      const events = yield* EventRepo;
      yield* calendars.upsertMany([calendar()]);
      yield* events.upsertMany([
        timedEvent({ id: 'endless', recurrence: ['RRULE:FREQ=WEEKLY'] }),
        timedEvent({ id: 'ended', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=2'] }),
        timedEvent({ id: 'until', recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20260901T000000Z'] }),
      ]);
      const window = yield* events.getWindow(
        Date.parse('2026-08-01T00:00:00Z'),
        Date.parse('2026-08-31T00:00:00Z'),
      );
      expect(window.masters.map((event) => event.id).sort()).toEqual(['endless', 'until']);
      const later = yield* events.getWindow(
        Date.parse('2027-01-01T00:00:00Z'),
        Date.parse('2027-01-31T00:00:00Z'),
      );
      expect(later.masters.map((event) => event.id)).toEqual(['endless']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect(
    'applyPage writes a page atomically and a failing page leaves the last one intact',
    () =>
      Effect.gen(function* () {
        const calendars = yield* CalendarRepo;
        const events = yield* EventRepo;
        yield* calendars.upsertMany([calendar()]);
        yield* events.applyPage('acc-1', 'cal-1', {
          deletions: [],
          mode: 'pull',
          upserts: [timedEvent({ id: 'a' }), timedEvent({ id: 'b' })],
        });
        // A row whose title violates NOT NULL fails the whole second page.
        const broken = { ...timedEvent({ id: 'c' }), title: null as unknown as string };
        const outcome = yield* Effect.result(
          events.applyPage('acc-1', 'cal-1', {
            deletions: ['a'],
            mode: 'pull',
            upserts: [timedEvent({ id: 'd' }), broken as EventRecord],
          }),
        );
        expect(outcome._tag).toBe('Failure');
        const window = yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'));
        expect(window.singles.map((event) => event.id).sort()).toEqual(['a', 'b']);
      }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('deleteByCalendar spares the sibling calendar; countByAccount counts rows', () =>
    Effect.gen(function* () {
      const calendars = yield* CalendarRepo;
      const events = yield* EventRepo;
      yield* calendars.upsertMany([calendar(), calendar({ id: 'cal-2', summary: 'Other' })]);
      yield* events.upsertMany([
        timedEvent({ id: 'a' }),
        timedEvent({ calendarId: 'cal-2', id: 'b' }),
        timedEvent({ calendarId: 'cal-2', id: 'c' }),
      ]);
      expect(yield* events.countByAccount()).toEqual([{ accountId: 'acc-1', eventCount: 3 }]);
      yield* events.deleteByCalendar('acc-1', 'cal-2');
      expect(yield* events.countByAccount()).toEqual([{ accountId: 'acc-1', eventCount: 1 }]);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('purge removes a calendar, its events and its sync state together', () =>
    Effect.gen(function* () {
      const calendars = yield* CalendarRepo;
      const events = yield* EventRepo;
      const states = yield* SyncStateRepo;
      yield* calendars.upsertMany([calendar(), calendar({ id: 'cal-2', summary: 'Other' })]);
      yield* events.upsertMany([
        timedEvent({ id: 'a' }),
        timedEvent({ calendarId: 'cal-2', id: 'b' }),
      ]);
      yield* states.set(syncState('events:cal-1', 'tok', 'idle'));
      yield* states.set(syncState('events:cal-2', 'tok', 'idle'));
      yield* calendars.purge('acc-1', ['cal-1']);
      expect((yield* calendars.list('acc-1')).map((row) => row.id)).toEqual(['cal-2']);
      expect(yield* events.countByAccount()).toEqual([{ accountId: 'acc-1', eventCount: 1 }]);
      expect(yield* states.get('acc-1', 'events:cal-1')).toBeNull();
      expect((yield* states.get('acc-1', 'events:cal-2'))?.syncToken).toBe('tok');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('summarizeEvents counts calendars still on their first full list', () =>
    Effect.gen(function* () {
      const states = yield* SyncStateRepo;
      yield* (yield* CalendarRepo).upsertMany([
        calendar(),
        calendar({ id: 'cal-2', summary: 'Two' }),
        calendar({ id: 'cal-3', summary: 'Three' }),
      ]);
      yield* states.set(syncState('calendarList', null, 'idle'));
      yield* states.set(syncState('events:cal-1', 'tok', 'idle'));
      yield* states.set(syncState('events:cal-2', null, 'syncing'));
      yield* states.set(syncState('events:cal-3', 'tok', 'syncing'));
      // A row for a calendar that no longer exists must not count.
      yield* states.set(syncState('events:gone', null, 'idle'));
      expect(yield* states.summarizeEvents()).toEqual([{ accountId: 'acc-1', importing: 2 }]);
      yield* states.remove('acc-1', 'events:cal-2');
      expect(yield* states.summarizeEvents()).toEqual([{ accountId: 'acc-1', importing: 1 }]);
    }).pipe(Effect.provide(freshDbLayer())),
  );
});
