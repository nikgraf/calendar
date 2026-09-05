import { Account, CalendarInfo, EventRecord, plainDateToUtcMs } from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  PendingOpRepo,
  reposLayer,
  runMigrations,
} from '@calendar/db';
import {
  ApiUnavailableError,
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { EventMutations } from './mutations.ts';

// Deletes fail transiently so queued ops stay observable: enqueueAndKick
// forks the drain, and a delete that succeeds could be removed before the
// test lists the queue.
const stubClient: GoogleCalendarClientShape = {
  deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
  getColors: () => Effect.succeed({ calendar: {} }),
  insertEvent: () => Effect.die('unexpected insert'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
  patchEvent: () => Effect.die('unexpected patch'),
};

const stubTasksClient: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('tasks not used in this test'),
  insertTask: () => Effect.die('tasks not used in this test'),
  listTaskLists: () => Effect.die('tasks not used in this test'),
  listTasks: () => Effect.die('tasks not used in this test'),
  patchTask: () => Effect.die('tasks not used in this test'),
};

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

const testLayer = EventMutations.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(seedAccounts)),
  Layer.provideMerge(reposLayer),
  Layer.provideMerge(Layer.effectDiscard(runMigrations)),
  Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
  Layer.provideMerge(reactivityLayer),
  Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
  Layer.provideMerge(Layer.succeed(GoogleCalendarClient, stubClient)),
  Layer.provideMerge(Layer.succeed(GoogleTasksClient, stubTasksClient)),
);

const master = new EventRecord({
  accountId: 'acc-1',
  calendarId: 'cal-1',
  endUtc: Date.parse('2026-07-01T10:00:00Z'),
  etag: '"m-1"',
  id: 'master1',
  isAllDay: false,
  recurrence: ['RRULE:FREQ=DAILY;COUNT=10'],
  startTimeZone: 'UTC',
  startUtc: Date.parse('2026-07-01T09:00:00Z'),
  status: 'confirmed',
  syncedAt: 1,
  syncStatus: 'synced',
  title: 'Daily',
  updatedAt: 1,
});

/** Original start of the 4th occurrence (July 4). */
const occurrence = Date.parse('2026-07-04T09:00:00Z');
const instanceId = 'master1_20260704T090000Z';

const target = {
  accountId: 'acc-1',
  calendarId: 'cal-1',
  masterId: 'master1',
  originalStartUtc: occurrence,
};

const seedMaster = Effect.gen(function* () {
  const calendars = yield* CalendarRepo;
  yield* calendars.upsertMany([
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-1',
      colorHex: '#3b82f6',
      id: 'cal-1',
      isPrimary: true,
      isVisible: true,
      summary: 'Work',
      timeZone: 'Europe/Vienna',
    }),
  ]);
  const events = yield* EventRepo;
  yield* events.upsertMany([master]);
});

const listOps = Effect.gen(function* () {
  return yield* (yield* PendingOpRepo).listAll();
});

describe('EventMutations recurring scopes', () => {
  it.effect('createEvent with recurrence writes a master and syncs the rule', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        endUtc: Date.parse('2026-07-10T10:00:00Z'),
        isAllDay: false,
        recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2'],
        startTimeZone: 'UTC',
        startUtc: Date.parse('2026-07-10T09:00:00Z'),
        title: 'Biweekly',
      });
      expect(record.recurrence).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2']);

      const events = yield* EventRepo;
      const window = yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'));
      expect(window.masters.some((event) => event.id === record.id)).toBe(true);

      const ops = yield* listOps;
      const create = ops.find((op) => op.eventId === record.id);
      expect(create?.kind).toBe('create');
      expect(create?.payload?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2']);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('instance update materializes an override under the Google instance id', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: {
          endUtc: Date.parse('2026-07-04T12:00:00Z'),
          startUtc: Date.parse('2026-07-04T11:00:00Z'),
        },
        scope: 'instance',
      });

      const events = yield* EventRepo;
      const override = yield* events.getById('acc-1', 'cal-1', instanceId);
      expect(override).not.toBeNull();
      expect(override!.recurringEventId).toBe('master1');
      expect(override!.originalStartUtc).toBe(occurrence);
      expect(override!.startUtc).toBe(Date.parse('2026-07-04T11:00:00Z'));
      expect(override!.recurrence).toBeUndefined();

      const untouched = yield* events.getById('acc-1', 'cal-1', 'master1');
      expect(untouched!.startUtc).toBe(master.startUtc);

      const ops = yield* listOps;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.kind).toBe('update');
      expect(ops[0]!.eventId).toBe(instanceId);
      expect(ops[0]!.baseEtag).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('instance delete writes a cancelled tombstone and a delete op', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      yield* mutations.deleteRecurring({ ...target, scope: 'instance' });

      const events = yield* EventRepo;
      const tombstone = yield* events.getById('acc-1', 'cal-1', instanceId);
      expect(tombstone!.status).toBe('cancelled');
      expect(tombstone!.originalStartUtc).toBe(occurrence);

      const ops = yield* listOps;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.kind).toBe('delete');
      expect(ops[0]!.eventId).toBe(instanceId);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('series update shifts the master by the occurrence delta', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      // Occurrence moved +2h and shortened to 30min → series follows.
      yield* mutations.updateRecurring({
        ...target,
        changes: {
          endUtc: Date.parse('2026-07-04T11:30:00Z'),
          startUtc: Date.parse('2026-07-04T11:00:00Z'),
          title: 'Daily (moved)',
        },
        scope: 'series',
      });

      const events = yield* EventRepo;
      const updated = yield* events.getById('acc-1', 'cal-1', 'master1');
      expect(updated!.startUtc).toBe(Date.parse('2026-07-01T11:00:00Z'));
      expect(updated!.endUtc).toBe(Date.parse('2026-07-01T11:30:00Z'));
      expect(updated!.title).toBe('Daily (moved)');
      expect(updated!.recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=10']);

      const ops = yield* listOps;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.kind).toBe('update');
      expect(ops[0]!.eventId).toBe('master1');
      expect(ops[0]!.baseEtag).toBe('"m-1"');
      expect(ops[0]!.payload?.recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=10']);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('following update splits the series into two masters', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: {
          endUtc: Date.parse('2026-07-04T15:00:00Z'),
          startUtc: Date.parse('2026-07-04T14:00:00Z'),
        },
        scope: 'following',
      });

      const events = yield* EventRepo;
      const truncated = yield* events.getById('acc-1', 'cal-1', 'master1');
      expect(truncated!.recurrence).toEqual(['RRULE:FREQ=DAILY;UNTIL=20260704T085959Z']);
      expect(truncated!.startUtc).toBe(master.startUtc);

      const window = yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'));
      const newMaster = window.masters.find((event) => event.id !== 'master1');
      expect(newMaster).toBeDefined();
      // 3 occurrences consumed before the split → 7 remain.
      expect(newMaster!.recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=7']);
      expect(newMaster!.startUtc).toBe(Date.parse('2026-07-04T14:00:00Z'));
      expect(newMaster!.endUtc).toBe(Date.parse('2026-07-04T15:00:00Z'));
      expect(newMaster!.recurringEventId).toBeUndefined();

      const ops = yield* listOps;
      expect(ops.map((op) => op.kind).sort()).toEqual(['create', 'update']);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('following delete truncates and drops later overrides', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      // A synced override on the July 5 occurrence — beyond the split.
      yield* events.upsertMany([
        new EventRecord({
          ...master,
          endUtc: Date.parse('2026-07-05T13:00:00Z'),
          etag: '"o-1"',
          id: 'master1_20260705T090000Z',
          originalStartUtc: Date.parse('2026-07-05T09:00:00Z'),
          recurrence: undefined,
          recurringEventId: 'master1',
          startUtc: Date.parse('2026-07-05T12:00:00Z'),
        }),
      ]);
      const mutations = yield* EventMutations;
      yield* mutations.deleteRecurring({ ...target, scope: 'following' });

      const truncated = yield* events.getById('acc-1', 'cal-1', 'master1');
      expect(truncated!.recurrence).toEqual(['RRULE:FREQ=DAILY;UNTIL=20260704T085959Z']);
      expect(yield* events.getById('acc-1', 'cal-1', 'master1_20260705T090000Z')).toBeNull();

      const ops = yield* listOps;
      expect(ops.map((op) => `${op.kind}:${op.eventId}`).sort()).toEqual([
        'delete:master1_20260705T090000Z',
        'update:master1',
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('series delete removes master plus overrides and cascades remotely', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      yield* events.upsertMany([
        new EventRecord({
          ...master,
          etag: '"o-1"',
          id: instanceId,
          originalStartUtc: occurrence,
          recurrence: undefined,
          recurringEventId: 'master1',
          startUtc: occurrence,
        }),
      ]);
      const mutations = yield* EventMutations;
      yield* mutations.deleteRecurring({ ...target, scope: 'series' });

      expect(yield* events.getById('acc-1', 'cal-1', 'master1')).toBeNull();
      expect(yield* events.getById('acc-1', 'cal-1', instanceId)).toBeNull();

      const ops = yield* listOps;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.kind).toBe('delete');
      expect(ops[0]!.eventId).toBe('master1');
      expect(ops[0]!.baseEtag).toBe('"m-1"');
    }).pipe(Effect.provide(testLayer)),
  );
});
