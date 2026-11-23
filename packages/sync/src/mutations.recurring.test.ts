import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import {
  Account,
  assembleWindow,
  Attendee,
  CalendarInfo,
  EventRecord,
  GeoLocation,
  plainDateToUtcMs,
} from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  PendingOpRepo,
  reposLayer,
  runMigrations,
} from '@calendar/db';
import {
  type GcalEvent,
  type GcalEventPatch,
  ApiUnavailableError,
  ConflictError,
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
  SyncTokenExpiredError,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Scheduler } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { SqlClient } from 'effect/sql/SqlClient';
import { describe } from 'vite-plus/test';
import { EventMutations } from './mutations.ts';
import { drawsFrom } from './splitSeries.ts';

// Deletes fail transiently so queued ops stay observable: enqueueAndKick
// forks the drain, and a delete that succeeds could be removed before the
// test lists the queue.
const stubClient: GoogleCalendarClientShape = {
  deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
  getColors: () => Effect.succeed({ calendar: {} }),
  getEvent: () => Effect.die('unexpected get'),
  insertCalendar: () => Effect.die('not used'),
  insertEvent: () => Effect.die('unexpected insert'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  moveEvent: () => Effect.die('unexpected move'),
  patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
  patchEvent: () => Effect.die('unexpected patch'),
  replaceEvent: () => Effect.die('not used'),
};

const stubTasksClient: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('tasks not used in this test'),
  insertTask: () => Effect.die('tasks not used in this test'),
  listTaskLists: () => Effect.die('tasks not used in this test'),
  listTasks: () => Effect.die('tasks not used in this test'),
  moveTask: () => Effect.die('tasks not used in this test'),
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

const testLayerWith = (client: GoogleCalendarClientShape) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
    Layer.provideMerge(Layer.effectDiscard(seedAccounts)),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, client)),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, stubTasksClient)),
  );

const testLayer = testLayerWith(stubClient);

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
      provider: 'google',
      summary: 'Work',
      timeZone: 'Europe/Vienna',
    }),
  ]);
  const events = yield* EventRepo;
  yield* events.upsertMany([master]);
});

/**
 * Keeps the drain a mutation forks from running before the next call: the
 * stub insert would stamp a create as sent in between.
 */
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

const listOps = Effect.gen(function* () {
  return yield* (yield* PendingOpRepo).listAll();
});

const rowOf = (id: string) =>
  Effect.gen(function* () {
    return yield* (yield* EventRepo).getById('acc-1', 'cal-1', id);
  });

/**
 * Discards a change as one Google was never sent. A delete or a redraw
 * that was tried waits for Google's word while Google is out of reach
 * (`finishDiscard`); these tests are about what a discard puts back.
 */
const discardAsUntried = (opId: string) =>
  Effect.gen(function* () {
    yield* (yield* SqlClient)`UPDATE pending_ops SET attempts = 0 WHERE id = ${opId}`;
    yield* (yield* EventMutations).discardPendingOp(opId);
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

  it.effect('an occurrence delete Google answers 410 for keeps its cancelled tombstone', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      yield* mutations.deleteRecurring({ ...target, scope: 'instance' });
      yield* mutations.processPendingOps();
      // 410: already deleted there (an earlier attempt landed, its
      // response lost). The tombstone is what keeps the occurrence away.
      expect(yield* listOps).toEqual([]);
      const tombstone = yield* (yield* EventRepo).getById('acc-1', 'cal-1', instanceId);
      expect(tombstone?.status).toBe('cancelled');
    }).pipe(
      Effect.provide(
        testLayerWith({
          ...stubClient,
          deleteEvent: () => Effect.fail(new SyncTokenExpiredError({ calendarId: 'cal-1' })),
        }),
      ),
    ),
  );

  it.effect('instance guest edits merge against the occurrence, not the master', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      const masterWithGuests = new EventRecord({
        ...master,
        attendees: [new Attendee({ email: 'guest@example.com', responseStatus: 'tentative' })],
      });
      yield* events.upsertMany([
        masterWithGuests,
        // An existing override where the guest already declined this one.
        new EventRecord({
          ...masterWithGuests,
          attendees: [new Attendee({ email: 'guest@example.com', responseStatus: 'declined' })],
          etag: '"o-1"',
          id: instanceId,
          originalStartUtc: target.originalStartUtc,
          recurrence: undefined,
          recurringEventId: 'master1',
        }),
      ]);
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { attendees: [{ email: 'guest@example.com' }, { email: 'new@example.com' }] },
        scope: 'instance',
      });
      const override = yield* events.getById('acc-1', 'cal-1', instanceId);
      expect(override!.attendees!.map((attendee) => attendee.responseStatus)).toEqual([
        'declined',
        'needsAction',
      ]);
      const ops = yield* listOps;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.attendeesChanged).toBe(true);
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

  it.effect('a series that starts on a second moves to the time picked for it', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      // 09:00:30 daily, as another client may have written it.
      yield* events.upsertMany([
        new EventRecord({
          ...master,
          endUtc: master.endUtc + 30_000,
          startUtc: master.startUtc + 30_000,
        }),
      ]);
      // "All events" from the July 4 occurrence, retimed to 10:00–11:00.
      yield* (yield* EventMutations).updateRecurring({
        ...target,
        changes: {
          endUtc: Date.parse('2026-07-04T11:00:00Z'),
          startUtc: Date.parse('2026-07-04T10:00:00Z'),
        },
        originalStartUtc: occurrence + 30_000,
        scope: 'series',
      });
      const updated = yield* events.getById('acc-1', 'cal-1', 'master1');
      expect(updated!.startUtc).toBe(Date.parse('2026-07-01T10:00:00Z'));
      expect(updated!.endUtc).toBe(Date.parse('2026-07-01T11:00:00Z'));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('series and instance edits keep, replace or drop location coordinates', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      const mutations = yield* EventMutations;
      const geo = new GeoLocation({ lat: 48.2, lng: 16.37, source: 'Stephansplatz 3, Wien' });

      yield* mutations.updateRecurring({
        ...target,
        changes: { geo, location: 'Stephansplatz 3, Wien' },
        scope: 'series',
      });
      expect((yield* events.getById('acc-1', 'cal-1', 'master1'))?.geo).toEqual(geo);

      // A title-only edit leaves the coordinates alone.
      yield* mutations.updateRecurring({ ...target, changes: { title: 'Mass' }, scope: 'series' });
      expect((yield* events.getById('acc-1', 'cal-1', 'master1'))?.geo).toEqual(geo);

      // An instance inherits them; moving just that occurrence drops its copy.
      yield* mutations.updateRecurring({
        ...target,
        changes: { location: 'Karlskirche' },
        scope: 'instance',
      });
      expect((yield* events.getById('acc-1', 'cal-1', instanceId))?.geo).toBeUndefined();
      expect((yield* events.getById('acc-1', 'cal-1', 'master1'))?.geo).toEqual(geo);

      // Changing the series location without new coordinates drops them.
      yield* mutations.updateRecurring({
        ...target,
        changes: { location: 'Online' },
        scope: 'series',
      });
      expect((yield* events.getById('acc-1', 'cal-1', 'master1'))?.geo).toBeUndefined();
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

  // A cut leaves the old series an UNTIL one second before the split
  // occurrence. Retimed earlier with the UNTIL left in place, the old
  // series drew the split day too, beside the new series' occurrence. The
  // bound moves with the time of day only: moved to another date, the
  // series still ends before the split (else the split reads as undone).
  it.effect.each([
    {
      days: ['2026-07-01T08:00', '2026-07-02T08:00', '2026-07-03T08:00'],
      label: 'an hour earlier',
      to: '2026-07-02T08:00',
      until: '20260704T075959Z',
    },
    {
      days: ['2026-07-01T11:00', '2026-07-02T11:00', '2026-07-03T11:00'],
      label: 'two hours later',
      to: '2026-07-02T11:00',
      until: '20260704T085959Z',
    },
    {
      days: ['2026-07-02T09:00', '2026-07-03T09:00'],
      label: 'a day later',
      to: '2026-07-03T09:00',
      until: '20260704T085959Z',
    },
    {
      // July 3's occurrence moves to July 4, 08:00: still before the cut.
      days: ['2026-07-02T08:00', '2026-07-03T08:00', '2026-07-04T08:00'],
      label: 'a day later and an hour earlier',
      to: '2026-07-03T08:00',
      until: '20260704T085959Z',
    },
  ])('a series cut by a split and moved $label keeps to its days', ({ days, to, until }) =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Talks' },
        scope: 'following',
      });
      yield* mutations.updateRecurring({
        ...target,
        changes: {
          endUtc: Date.parse(`${to}:00Z`) + 3_600_000,
          startUtc: Date.parse(`${to}:00Z`),
        },
        originalStartUtc: Date.parse('2026-07-02T09:00:00Z'),
        scope: 'series',
      });

      const events = yield* EventRepo;
      const moved = yield* events.getById('acc-1', 'cal-1', 'master1');
      expect(moved!.recurrence).toEqual([`RRULE:FREQ=DAILY;UNTIL=${until}`]);
      expect(drawsFrom(moved!, occurrence)).toBe(false);
      const from = Date.parse('2026-07-01T00:00:00Z');
      const end = Date.parse('2026-07-12T00:00:00Z');
      expect(
        assembleWindow(yield* events.getWindow(from, end), from, end)
          .filter((event) => event.recurringEventId === 'master1')
          .map((event) => new Date(event.startUtc).toISOString()),
      ).toEqual(days.map((day) => `${day}:00.000Z`));
      // Google gets the moved bound with the moved start.
      const update = (yield* listOps).findLast(
        (op) => op.kind === 'update' && op.eventId === 'master1',
      );
      expect(update?.payload?.recurrence).toEqual([`RRULE:FREQ=DAILY;UNTIL=${until}`]);
    }).pipe(Effect.provide(testLayer)),
  );

  // A series on another zone's clock, retimed by an hour across that
  // zone's midnight: still an hour, not a day less or more. Los Angeles,
  // daily at 00:30 PDT (07:30Z) moved to 23:30 the evening before, and
  // daily at 23:30 PDT (06:30Z) moved to 00:30 the morning after.
  it.effect.each([
    {
      cut: '2026-07-04T07:30:00Z',
      days: ['2026-07-01T06:30', '2026-07-02T06:30', '2026-07-03T06:30'],
      label: 'an hour earlier, to the evening before',
      start: '2026-07-01T07:30:00Z',
      to: '2026-07-02T06:30',
      until: '20260704T062959Z',
    },
    {
      cut: '2026-07-04T06:30:00Z',
      days: ['2026-07-01T07:30', '2026-07-02T07:30', '2026-07-03T07:30'],
      label: 'an hour later, to the morning after',
      start: '2026-07-01T06:30:00Z',
      to: '2026-07-02T07:30',
      until: '20260704T062959Z',
    },
  ])(
    'a Los Angeles series cut by a split and moved $label keeps to its days',
    ({ cut, days, start, to, until }) =>
      Effect.gen(function* () {
        yield* seedMaster;
        const events = yield* EventRepo;
        const startUtc = Date.parse(start);
        yield* events.upsertMany([
          new EventRecord({
            ...master,
            endUtc: startUtc + 1_800_000,
            startTimeZone: 'America/Los_Angeles',
            startUtc,
          }),
        ]);
        const mutations = yield* EventMutations;
        yield* mutations.updateRecurring({
          ...target,
          changes: { title: 'Talks' },
          originalStartUtc: Date.parse(cut),
          scope: 'following',
        });
        const opened = startUtc + 86_400_000;
        yield* mutations.updateRecurring({
          ...target,
          changes: {
            endUtc: Date.parse(`${to}:00Z`) + 1_800_000,
            startUtc: Date.parse(`${to}:00Z`),
          },
          originalStartUtc: opened,
          scope: 'series',
        });

        const moved = yield* events.getById('acc-1', 'cal-1', 'master1');
        expect(moved!.recurrence).toEqual([`RRULE:FREQ=DAILY;UNTIL=${until}`]);
        expect(drawsFrom(moved!, Date.parse(cut))).toBe(false);
        const from = Date.parse('2026-06-30T00:00:00Z');
        const end = Date.parse('2026-07-12T00:00:00Z');
        expect(
          assembleWindow(yield* events.getWindow(from, end), from, end)
            .filter((event) => event.recurringEventId === 'master1')
            .map((event) => new Date(event.startUtc).toISOString()),
        ).toEqual(days.map((day) => `${day}:00.000Z`));
      }).pipe(Effect.provide(testLayer)),
  );

  // The same bound on the other path: a series an earlier split ended,
  // split again and moved to another time, took the remainder's UNTIL as
  // it was and drew the first split's day too.
  it.effect.each([
    {
      days: ['2026-07-03T08:00', '2026-07-04T08:00', '2026-07-05T08:00'],
      label: 'an hour earlier',
      to: '2026-07-03T08:00',
      until: '20260706T075959Z',
    },
    {
      days: ['2026-07-03T11:00', '2026-07-04T11:00', '2026-07-05T11:00'],
      label: 'two hours later',
      to: '2026-07-03T11:00',
      until: '20260706T085959Z',
    },
    {
      days: ['2026-07-04T09:00', '2026-07-05T09:00'],
      label: 'a day later',
      to: '2026-07-04T09:00',
      until: '20260706T085959Z',
    },
  ])(
    'a split of a series an earlier split ended, moved $label, ends where it did',
    ({ days, to, until }) =>
      Effect.gen(function* () {
        yield* seedMaster;
        const mutations = yield* EventMutations;
        yield* mutations.updateRecurring({
          ...target,
          changes: { title: 'From July 6' },
          originalStartUtc: Date.parse('2026-07-06T09:00:00Z'),
          scope: 'following',
        });
        yield* mutations.updateRecurring({
          ...target,
          changes: {
            endUtc: Date.parse(`${to}:00Z`) + 3_600_000,
            startUtc: Date.parse(`${to}:00Z`),
          },
          originalStartUtc: Date.parse('2026-07-03T09:00:00Z'),
          scope: 'following',
        });

        const events = yield* EventRepo;
        const from = Date.parse('2026-07-01T00:00:00Z');
        const end = Date.parse('2026-07-12T00:00:00Z');
        const window = yield* events.getWindow(from, end);
        const middle = window.masters.find((event) => event.startUtc === Date.parse(`${to}:00Z`));
        expect(middle?.recurrence).toEqual([`RRULE:FREQ=DAILY;UNTIL=${until}`]);
        expect(drawsFrom(middle!, Date.parse('2026-07-06T09:00:00Z'))).toBe(false);
        expect(
          assembleWindow(window, from, end)
            .filter((event) => event.recurringEventId === middle?.id)
            .map((event) => new Date(event.startUtc).toISOString()),
        ).toEqual(days.map((day) => `${day}:00.000Z`));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect('following update of a set of only RDATE lines splits its dates', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      // July 1 (DTSTART), July 4 and July 8: explicit dates, no rule.
      yield* events.upsertMany([
        new EventRecord({
          ...master,
          recurrence: ['RDATE:20260704T090000Z,20260708T090000Z'],
        }),
      ]);
      const mutations = yield* EventMutations;
      // Split on July 4: the old master keeps July 1, the new one takes July 4 and 8.
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Talks' },
        scope: 'following',
      });
      const truncated = yield* events.getById('acc-1', 'cal-1', 'master1');
      expect(truncated!.recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=1']);
      const window = yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'));
      const newMaster = window.masters.find((event) => event.id !== 'master1');
      expect(newMaster!.recurrence).toEqual(['RDATE:20260708T090000Z']);
      expect(newMaster!.startUtc).toBe(occurrence);
      expect(newMaster!.title).toBe('Talks');
    }).pipe(Effect.provide(testLayer)),
  );

  for (const allDay of [false, true]) {
    for (const rule of [
      'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=5',
      'RRULE:FREQ=WEEKLY;COUNT=5',
      'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20260720T090000Z',
      'RRULE:FREQ=WEEKLY',
    ]) {
      it.effect(
        `refuses an RDATE-only following split without writing (${allDay ? 'all-day' : 'timed'}, ${rule})`,
        () =>
          Effect.gen(function* () {
            yield* seedMaster;
            const events = yield* EventRepo;
            const start = Date.parse(`2026-07-06T${allDay ? '00' : '09'}:00:00Z`);
            const split = start + 86_400_000;
            const record = new EventRecord({
              ...master,
              ...(allDay ? { endDate: '2026-07-07', startDate: '2026-07-06' } : {}),
              endUtc: start + (allDay ? 86_400_000 : 3_600_000),
              isAllDay: allDay,
              recurrence: [
                allDay ? rule.replace('20260720T090000Z', '20260720') : rule,
                allDay ? 'RDATE;VALUE=DATE:20260707' : 'RDATE:20260707T090000Z',
              ],
              startUtc: start,
            });
            yield* events.upsertMany([record]);
            const mutations = yield* EventMutations;
            const error = yield* Effect.flip(
              mutations.updateRecurring({
                ...target,
                changes: { title: 'Changed' },
                originalStartUtc: split,
                scope: 'following',
              }),
            );
            expect(error._tag).toBe('RecurringSplitUnsupportedError');
            expect(error.message).toContain('This event');
            expect(yield* rowOf('master1')).toEqual(record);
            expect(yield* listOps).toEqual([]);
            const window = yield* events.getWindow(start - 1, Date.parse('2027-01-01T00:00:00Z'));
            expect(window.masters).toEqual([record]);
            expect(window.overrides).toEqual([]);
            expect(window.singles).toEqual([]);
          }).pipe(Effect.provide(testLayer)),
      );
    }
  }

  it.effect('refusing a different-wall-time split preserves queued edits and overrides', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      yield* events.upsertMany([
        new EventRecord({
          ...master,
          recurrence: ['RRULE:FREQ=DAILY;COUNT=10', 'RDATE:20260704T140000Z'],
        }),
      ]);
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Only here' },
        scope: 'instance',
      });
      const before = yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'));
      const queued = yield* listOps;
      expect(queued).toHaveLength(1);
      for (const recurrence of [undefined, null, ['RRULE:FREQ=WEEKLY;COUNT=2']]) {
        const error = yield* Effect.flip(
          mutations.updateRecurring({
            ...target,
            changes: { recurrence, title: 'Changed' },
            originalStartUtc: Date.parse('2026-07-04T14:00:00Z'),
            scope: 'following',
          }),
        );
        expect(error._tag).toBe('RecurringSplitUnsupportedError');
        expect(yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'))).toEqual(before);
        expect(yield* listOps).toEqual(queued);
      }
      // The offered alternatives still work at that same extra occurrence.
      for (const scope of ['instance', 'series'] as const) {
        yield* mutations.updateRecurring({
          ...target,
          changes: { title: `Changed ${scope}` },
          originalStartUtc: Date.parse('2026-07-04T14:00:00Z'),
          scope,
        });
      }
      expect((yield* rowOf('master1'))?.title).toBe('Changed series');
    }).pipe(Effect.provide(testLayer), noYield),
  );

  it.effect('following update on the last RDATE value creates a single event', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      yield* events.upsertMany([
        new EventRecord({ ...master, recurrence: ['RDATE:20260702T090000Z,20260704T090000Z'] }),
      ]);
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Last talk' },
        scope: 'following',
      });
      const truncated = yield* events.getById('acc-1', 'cal-1', 'master1');
      expect(truncated!.recurrence).toEqual(['RDATE:20260702T090000Z']);
      const window = yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'));
      expect(window.masters.map((event) => event.id)).toEqual(['master1']);
      const single = window.singles.find((event) => event.title === 'Last talk');
      expect(single!.recurrence).toBeUndefined();
      expect(single!.startUtc).toBe(occurrence);
      const ops = yield* listOps;
      const create = ops.find((op) => op.kind === 'create');
      expect(create!.payload!.recurrence).toBeUndefined();
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

      // Google cancels it with the cut: nothing is queued for it, and the
      // cut holds Google's copy of it for as long as it waits.
      const ops = yield* listOps;
      expect(ops.map((op) => `${op.kind}:${op.eventId}`)).toEqual(['update:master1']);
      expect(ops[0]?.beforeOverrides?.map((copy) => [copy.id, copy.etag])).toEqual([
        ['master1_20260705T090000Z', '"o-1"'],
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

describe('what a save for all events takes from the changed occurrences', () => {
  const HOUR = 3_600_000;
  const edited = new EventRecord({
    ...master,
    etag: '"o-1"',
    id: instanceId,
    originalStartUtc: occurrence,
    recurrence: undefined,
    recurringEventId: 'master1',
    startUtc: occurrence,
    title: 'Daily (moved)',
  });
  const deletedAt = occurrence + 2 * 24 * HOUR;
  const deleted = new EventRecord({
    ...master,
    etag: '"o-2"',
    id: 'master1_20260706T090000Z',
    originalStartUtc: deletedAt,
    recurrence: undefined,
    recurringEventId: 'master1',
    startUtc: deletedAt,
    status: 'cancelled',
  });
  const seeded = Effect.gen(function* () {
    yield* seedMaster;
    yield* (yield* EventRepo).upsertMany([edited, deleted]);
  });
  const stored = Effect.gen(function* () {
    const rows = yield* (yield* EventRepo).listOverrides('acc-1', 'cal-1', 'master1');
    return [
      (yield* rowOf('master1'))?.startUtc,
      rows.map((row) => `${row.id} ${row.status}`).sort(),
      (yield* listOps).length,
    ];
  });

  it.effect('new times name the occurrence that loses its change and the day that comes back', () =>
    Effect.gen(function* () {
      yield* seeded;
      const before = yield* stored;
      const loss = yield* (yield* EventMutations).previewSeriesEdit({
        ...target,
        changes: { endUtc: occurrence + 2 * HOUR, startUtc: occurrence + HOUR },
        scope: 'series',
      });
      expect(loss).toEqual({ changed: 1, deleted: 1 });
      // Asked, not done: nothing is written and nothing queued.
      expect(yield* stored).toEqual(before);
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('an edit that keeps the slots takes nothing', () =>
    Effect.gen(function* () {
      yield* seeded;
      const mutations = yield* EventMutations;
      expect(
        yield* mutations.previewSeriesEdit({
          ...target,
          changes: { title: 'Standup' },
          scope: 'series',
        }),
      ).toEqual({ changed: 0, deleted: 0 });
      // A longer event from the same start: Google keeps the exceptions.
      expect(
        yield* mutations.previewSeriesEdit({
          ...target,
          changes: { endUtc: occurrence + 2 * HOUR, startUtc: occurrence },
          scope: 'series',
        }),
      ).toEqual({ changed: 0, deleted: 0 });
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('a shorter series or other weekdays take them for good, which is no question', () =>
    // Review (Opus): the count was every exception the save removed, so
    // "ends after 3" said a day deleted past the new end "comes back".
    Effect.gen(function* () {
      yield* seeded;
      const mutations = yield* EventMutations;
      for (const recurrence of [
        // July 4 and 6 lie past the third occurrence.
        ['RRULE:FREQ=DAILY;COUNT=3'],
        // July 4 2026 is a Saturday, July 6 a Monday: Sundays draw neither.
        ['RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=10'],
      ]) {
        expect(
          yield* mutations.previewSeriesEdit({
            ...target,
            changes: { recurrence },
            scope: 'series',
          }),
        ).toEqual({ changed: 0, deleted: 0 });
      }
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('an occurrence deleted here and not synced yet counts as coming back', () =>
    // Its delete waits for a slot the new times take away on Google: the
    // day shows again, and the delete finds nothing left to remove.
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      yield* mutations.deleteRecurring({ ...target, scope: 'instance' });
      expect(
        yield* mutations.previewSeriesEdit({
          ...target,
          changes: { endUtc: occurrence + 2 * HOUR, startUtc: occurrence + HOUR },
          scope: 'series',
        }),
      ).toEqual({ changed: 0, deleted: 1 });
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('one occurrence, or a split later in the series, is not asked about', () =>
    Effect.gen(function* () {
      yield* seeded;
      const mutations = yield* EventMutations;
      const changes = { endUtc: occurrence + 2 * HOUR, startUtc: occurrence + HOUR };
      for (const scope of ['instance', 'following'] as const) {
        expect(yield* mutations.previewSeriesEdit({ ...target, changes, scope })).toEqual({
          changed: 0,
          deleted: 0,
        });
      }
    }).pipe(noYield, Effect.provide(testLayer)),
  );
});

describe('a discard that asks Google while the user goes on', () => {
  const HOUR = 3_600_000;
  const moved = new EventRecord({
    ...master,
    etag: '"o-1"',
    id: instanceId,
    originalStartUtc: occurrence,
    recurrence: undefined,
    recurringEventId: 'master1',
    startUtc: occurrence + 2 * HOUR,
    title: 'Daily (moved)',
  });

  it.effect('a change built on meanwhile is kept, not taken back by the late answer', () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<void>();
      // Google never got the new times: its answer is the series as it was.
      const client: GoogleCalendarClientShape = {
        ...stubClient,
        getEvent: () =>
          Effect.andThen(
            Deferred.succeed(asked, undefined),
            Effect.as(Deferred.await(answer), {
              end: { dateTime: '2026-07-01T10:00:00Z', timeZone: 'UTC' },
              etag: '"m-1"',
              id: 'master1',
              recurrence: ['RRULE:FREQ=DAILY;COUNT=10'],
              start: { dateTime: '2026-07-01T09:00:00Z', timeZone: 'UTC' },
              status: 'confirmed' as const,
              summary: master.title,
            }),
          ),
      };
      return yield* Effect.gen(function* () {
        yield* seedMaster;
        yield* (yield* EventRepo).upsertMany([moved]);
        const mutations = yield* EventMutations;
        const series = { ...target, originalStartUtc: master.startUtc, scope: 'series' as const };
        yield* mutations.updateRecurring({
          ...series,
          changes: { endUtc: master.endUtc + HOUR, startUtc: master.startUtc + HOUR },
        });
        yield* mutations.processPendingOps();
        const [retime] = yield* listOps;
        expect(retime?.attempts).toBeGreaterThan(0);
        const discard = yield* Effect.forkChild(mutations.discardPendingOp(retime!.id));
        yield* Deferred.await(asked);
        // The series still shows the new times, and the user renames it there.
        yield* mutations.updateRecurring({
          ...series,
          changes: { title: 'Renamed' },
          originalStartUtc: master.startUtc + HOUR,
        });
        yield* Deferred.succeed(answer, undefined);
        yield* Fiber.join(discard);
        const ops = yield* listOps;
        expect(ops.map((op) => [op.kind, op.discarded, op.payload?.title])).toEqual([
          ['update', undefined, 'Renamed'],
        ]);
        // Still the series the user sees: at the new times, renamed, and
        // without the occurrence the new times drop.
        const row = yield* rowOf('master1');
        expect([row?.title, row?.startUtc]).toEqual(['Renamed', master.startUtc + HOUR]);
        expect(yield* rowOf(instanceId)).toBeNull();
      }).pipe(Effect.provide(testLayerWith(client)));
    }),
  );
});

/** A Google date-time in UTC. */
const iso = (utc: number) => ({ dateTime: new Date(utc).toISOString(), timeZone: 'UTC' });

describe('an occurrence edited again while its first edit is out', () => {
  const HOUR = 3_600_000;
  /** Google's exception after a PATCH: the series at the slot with what the PATCH named. */
  const exceptionAfter = (event: GcalEventPatch, etag: string): GcalEvent => ({
    end: iso(Date.parse(event.end?.dateTime ?? '') || occurrence + HOUR),
    etag,
    id: instanceId,
    originalStartTime: iso(occurrence),
    recurringEventId: 'master1',
    start: iso(Date.parse(event.start?.dateTime ?? '') || occurrence),
    status: 'confirmed',
    summary: typeof event.summary === 'string' ? event.summary : master.title,
  });

  for (const [what, firstEdit, secondEdit] of [
    [
      'new times',
      { endUtc: occurrence + 2 * HOUR, startUtc: occurrence + HOUR },
      { endUtc: occurrence + 3 * HOUR, startUtc: occurrence + 2 * HOUR },
    ],
    ['a new title', { title: 'First' }, { title: 'Second' }],
  ] as const) {
    it.effect(`is not asked about its own first edit when that lands (${what})`, () =>
      // Review (Codex): a plain occurrence has no etag to check, so its
      // first PATCH goes unchecked, and its reply is laid under what
      // still waits as Google's newer version. The second edit, queued in
      // its place meanwhile, was measured against that reply: the first
      // edit's own change read as another device's, and the second was
      // parked.
      Effect.gen(function* () {
        const sent = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        let writes = 0;
        const client: GoogleCalendarClientShape = {
          ...stubClient,
          patchEvent: ({ event }) => {
            writes += 1;
            const reply = exceptionAfter(event, `"o-${String(writes)}"`);
            return writes === 1
              ? Effect.andThen(
                  Deferred.succeed(sent, undefined),
                  Effect.as(Deferred.await(answer), reply),
                )
              : Effect.succeed(reply);
          },
        };
        return yield* Effect.gen(function* () {
          yield* seedMaster;
          const mutations = yield* EventMutations;
          const edit = (changes: { endUtc?: number; startUtc?: number; title?: string }) =>
            mutations.updateRecurring({ ...target, changes, scope: 'instance' });
          yield* edit(firstEdit);
          const drain = yield* Effect.forkChild(mutations.processPendingOps());
          yield* Deferred.await(sent);
          yield* edit(secondEdit);
          yield* Deferred.succeed(answer, undefined);
          yield* Fiber.join(drain);
          // Not parked: the second edit goes out too, and is what stays.
          yield* mutations.processPendingOps();
          expect((yield* listOps).map((op) => [op.kind, op.conflictAt])).toEqual([]);
          expect(writes).toBe(2);
          const row = yield* rowOf(instanceId);
          expect([row?.title, row?.startUtc, row?.syncStatus]).toEqual([
            secondEdit.title ?? master.title,
            secondEdit.startUtc ?? occurrence,
            'synced',
          ]);
        }).pipe(Effect.provide(testLayerWith(client)));
      }),
    );
  }
});

describe('discarding a change of a series', () => {
  const override = new EventRecord({
    ...master,
    etag: '"o-1"',
    id: instanceId,
    originalStartUtc: occurrence,
    recurrence: undefined,
    recurringEventId: 'master1',
    startUtc: occurrence,
    title: 'Daily (moved)',
  });
  it.effect('an occurrence edit that made the override removes it again', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Moved' },
        scope: 'instance',
      });
      const [op] = yield* listOps;
      expect(op?.beforePayload).toBeNull();
      expect(yield* rowOf(instanceId)).not.toBeNull();

      yield* mutations.discardPendingOp(op!.id);
      expect(yield* rowOf(instanceId)).toBeNull();
      expect(yield* listOps).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('an occurrence delete over an override puts the override back', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      yield* (yield* EventRepo).upsertMany([override]);
      const mutations = yield* EventMutations;
      yield* mutations.deleteRecurring({ ...target, scope: 'instance' });
      expect((yield* rowOf(instanceId))?.status).toBe('cancelled');
      const [op] = yield* listOps;
      expect(op?.beforePayload?.title).toBe('Daily (moved)');

      yield* mutations.discardPendingOp(op!.id);
      const row = yield* rowOf(instanceId);
      expect(row?.status).toBe('confirmed');
      expect(row?.title).toBe('Daily (moved)');
      expect(row?.syncStatus).toBe('synced');
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('an answer discarded under an occurrence delete keeps its tombstone pending', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      const invited = new EventRecord({
        ...override,
        attendees: [
          new Attendee({ email: 'acc-1@example.com', isSelf: true, responseStatus: 'needsAction' }),
          new Attendee({
            email: 'host@example.com',
            isOrganizer: true,
            responseStatus: 'accepted',
          }),
        ],
        organizerEmail: 'host@example.com',
      });
      yield* events.upsertMany([invited]);
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: instanceId,
        response: 'accepted',
      });
      yield* mutations.deleteRecurring({ ...target, scope: 'instance' });
      const queued = yield* listOps;
      expect(queued.map((op) => op.kind)).toEqual(['rsvp', 'delete']);

      yield* mutations.discardPendingOp(queued[0]!.id);
      const row = yield* rowOf(instanceId);
      expect(row?.status).toBe('cancelled');
      expect(row?.syncStatus).toBe('pending');
      // The delete still owns it: a pull's copy of the exception stays out.
      yield* events.upsertMany([new EventRecord({ ...invited, etag: '"o-2"' })], { mode: 'pull' });
      expect((yield* rowOf(instanceId))?.status).toBe('cancelled');
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    'a series delete after an occurrence delete keeps the override, not its tombstone',
    () =>
      Effect.gen(function* () {
        yield* seedMaster;
        yield* (yield* EventRepo).upsertMany([override]);
        const mutations = yield* EventMutations;
        yield* mutations.deleteRecurring({ ...target, scope: 'instance' });
        yield* mutations.deleteRecurring({ ...target, scope: 'series' });
        const [op] = yield* listOps;
        // The tombstone is the occurrence delete's own row, not a pull's copy.
        expect(op?.beforeOverrides?.map((row) => [row.title, row.status])).toEqual([
          ['Daily (moved)', 'confirmed'],
        ]);

        yield* discardAsUntried(op!.id);
        expect((yield* rowOf(instanceId))?.status).toBe('confirmed');
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect('a series delete puts the exceptions back as Google has them', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      yield* (yield* EventRepo).upsertMany([override]);
      const mutations = yield* EventMutations;
      // One exception edited offline, another materialized offline.
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Edited offline' },
        scope: 'instance',
      });
      const materializedAt = Date.parse('2026-07-06T09:00:00Z');
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Only here' },
        originalStartUtc: materializedAt,
        scope: 'instance',
      });
      yield* mutations.deleteRecurring({ ...target, scope: 'series' });
      const [op] = yield* listOps;
      // Only the exception Google has, in the state Google has it.
      expect(op?.beforeOverrides?.map((row) => [row.id, row.title])).toEqual([
        [instanceId, 'Daily (moved)'],
      ]);

      yield* mutations.discardPendingOp(op!.id);
      expect((yield* rowOf(instanceId))?.title).toBe('Daily (moved)');
      expect(yield* rowOf('master1_20260706T090000Z')).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    'a series delete discarded after a pull put the master back still restores the exceptions',
    () =>
      Effect.gen(function* () {
        yield* seedMaster;
        const events = yield* EventRepo;
        yield* events.upsertMany([override]);
        const mutations = yield* EventMutations;
        yield* mutations.deleteRecurring({ ...target, scope: 'series' });
        // An incremental pull re-sent the master (changed on Google) but
        // not its unchanged exception.
        yield* events.upsertMany([
          new EventRecord({ ...master, etag: '"m-2"', title: 'Daily (Google)' }),
        ]);
        const [op] = yield* listOps;

        yield* mutations.discardPendingOp(op!.id);
        expect((yield* rowOf('master1'))?.title).toBe('Daily (Google)');
        expect((yield* rowOf(instanceId))?.title).toBe('Daily (moved)');
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect('a series delete after an offline series rename keeps the exceptions’ own text', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      yield* (yield* EventRepo).upsertMany([override]);
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Renamed' },
        scope: 'series',
      });
      // The rename was carried onto the exception locally, as Google would.
      expect((yield* rowOf(instanceId))?.title).toBe('Renamed');
      yield* mutations.deleteRecurring({ ...target, scope: 'series' });
      const [op] = yield* listOps;
      expect(op?.beforeOverrides?.map((row) => row.title)).toEqual(['Daily (moved)']);

      yield* mutations.discardPendingOp(op!.id);
      expect((yield* rowOf('master1'))?.title).toBe('Daily');
      expect((yield* rowOf(instanceId))?.title).toBe('Daily (moved)');
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    'a following delete after an offline series rename snapshots the exception’s own text',
    () =>
      Effect.gen(function* () {
        yield* seedMaster;
        yield* (yield* EventRepo).upsertMany([override]);
        const mutations = yield* EventMutations;
        yield* mutations.updateRecurring({
          ...target,
          changes: { title: 'Renamed' },
          scope: 'series',
        });
        yield* mutations.deleteRecurring({ ...target, scope: 'following' });
        const [cut] = yield* listOps;
        expect(cut?.beforeOverrides?.map((copy) => [copy.id, copy.title])).toEqual([
          [instanceId, 'Daily (moved)'],
        ]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    'an occurrence edit under a queued series rename snapshots the exception’s own text',
    () =>
      Effect.gen(function* () {
        yield* seedMaster;
        yield* (yield* EventRepo).upsertMany([override]);
        const mutations = yield* EventMutations;
        yield* mutations.updateRecurring({
          ...target,
          changes: { title: 'Renamed' },
          scope: 'series',
        });
        yield* mutations.updateRecurring({
          ...target,
          changes: { title: 'Edited' },
          scope: 'instance',
        });
        const ops = yield* listOps;
        const series = ops.find((op) => op.eventId === 'master1');
        const instance = ops.find((op) => op.eventId === instanceId);
        expect(instance?.beforePayload?.title).toBe('Daily (moved)');

        yield* mutations.discardPendingOp(series!.id);
        expect((yield* rowOf(instanceId))?.title).toBe('Edited');
        yield* mutations.discardPendingOp(instance!.id);
        const row = yield* rowOf(instanceId);
        expect(row?.title).toBe('Daily (moved)');
        expect(row?.syncStatus).toBe('synced');
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect('an RSVP that lands on an occurrence keeps the override its queued edit made', () =>
    Effect.gen(function* () {
      const invitedMaster = new EventRecord({
        ...master,
        attendees: [
          new Attendee({
            email: 'organizer@example.com',
            isOrganizer: true,
            responseStatus: 'accepted',
          }),
          new Attendee({ email: 'acc-1@example.com', responseStatus: 'needsAction' }),
        ],
      });
      yield* seedMaster;
      yield* (yield* EventRepo).upsertMany([invitedMaster]);
      const mutations = yield* EventMutations;
      // The edit materializes the override and stays offline; the RSVP lands.
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Moved' },
        scope: 'instance',
      });
      yield* mutations.respondToEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: instanceId,
        response: 'accepted',
      });
      yield* mutations.processPendingOps();
      const [edit] = yield* listOps;
      expect(edit?.kind).toBe('update');
      // What Google acknowledged is what the edit replaces now, no longer "nothing".
      expect(edit?.beforePayload?.title).toBe('Daily');

      yield* mutations.discardPendingOp(edit!.id);
      const row = yield* rowOf(instanceId);
      expect(row?.title).toBe('Daily');
      expect(
        row?.attendees?.find((attendee) => attendee.email === 'acc-1@example.com')?.responseStatus,
      ).toBe('accepted');
    }).pipe(
      Effect.provide(
        testLayerWith({
          ...stubClient,
          patchEvent: ({ event, eventId }) =>
            'attendees' in event
              ? Effect.succeed({
                  attendees: event.attendees,
                  end: { dateTime: '2026-07-04T10:00:00Z' },
                  etag: '"o-2"',
                  id: eventId,
                  recurringEventId: 'master1',
                  start: { dateTime: '2026-07-04T09:00:00Z' },
                  status: 'confirmed',
                  summary: 'Daily',
                })
              : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        }),
      ),
    ),
  );

  it.effect(
    'a landed series rename moves a queued occurrence edit’s snapshot to the carried text',
    () =>
      Effect.gen(function* () {
        yield* seedMaster;
        yield* (yield* EventRepo).upsertMany([override]);
        const mutations = yield* EventMutations;
        yield* mutations.updateRecurring({
          ...target,
          changes: { title: 'Renamed' },
          scope: 'series',
        });
        yield* mutations.updateRecurring({
          ...target,
          changes: { location: 'Room 9' },
          scope: 'instance',
        });
        // Only the series patch lands; the occurrence edit stays offline.
        yield* mutations.processPendingOps();
        const [edit] = yield* listOps;
        expect(edit?.eventId).toBe(instanceId);
        // Google carried the rename onto the exception: that is what the edit replaces now.
        expect(edit?.beforePayload?.title).toBe('Renamed');

        yield* mutations.discardPendingOp(edit!.id);
        const row = yield* rowOf(instanceId);
        expect(row?.title).toBe('Renamed');
        expect(row?.location).toBeUndefined();
        expect(row?.syncStatus).toBe('synced');
      }).pipe(
        Effect.provide(
          testLayerWith({
            ...stubClient,
            patchEvent: ({ event, eventId }) =>
              eventId === 'master1'
                ? Effect.succeed({
                    end: { dateTime: '2026-07-01T10:00:00Z' },
                    etag: '"m-2"',
                    id: eventId,
                    recurrence: ['RRULE:FREQ=DAILY;COUNT=10'],
                    start: { dateTime: '2026-07-01T09:00:00Z', timeZone: 'UTC' },
                    status: 'confirmed',
                    summary: typeof event.summary === 'string' ? event.summary : 'Daily',
                  })
                : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          }),
        ),
      ),
  );

  it.effect('an occurrence edit discarded under a queued RSVP keeps the override for it', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      yield* (yield* EventRepo).upsertMany([
        new EventRecord({
          ...master,
          attendees: [
            new Attendee({
              email: 'organizer@example.com',
              isOrganizer: true,
              responseStatus: 'accepted',
            }),
            new Attendee({ email: 'acc-1@example.com', responseStatus: 'needsAction' }),
          ],
        }),
      ]);
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Moved' },
        scope: 'instance',
      });
      yield* mutations.respondToEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: instanceId,
        response: 'accepted',
      });
      const edit = (yield* listOps).find((op) => op.kind === 'update');
      yield* mutations.discardPendingOp(edit!.id);
      const row = yield* rowOf(instanceId);
      expect(row?.syncStatus).toBe('pending');
      expect(
        row?.attendees?.find((attendee) => attendee.email === 'acc-1@example.com')?.responseStatus,
      ).toBe('accepted');
      expect((yield* listOps).map((op) => op.kind)).toEqual(['rsvp']);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    'a series delete discarded under an occurrence RSVP leaves that exception pending',
    () =>
      Effect.gen(function* () {
        yield* seedMaster;
        const events = yield* EventRepo;
        yield* events.upsertMany([
          new EventRecord({
            ...override,
            attendees: [
              new Attendee({
                email: 'organizer@example.com',
                isOrganizer: true,
                responseStatus: 'accepted',
              }),
              new Attendee({ email: 'acc-1@example.com', responseStatus: 'needsAction' }),
            ],
          }),
        ]);
        const mutations = yield* EventMutations;
        yield* mutations.respondToEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          eventId: instanceId,
          response: 'accepted',
        });
        yield* mutations.deleteRecurring({ ...target, scope: 'series' });
        const remove = (yield* listOps).find((op) => op.kind === 'delete');
        yield* discardAsUntried(remove!.id);
        const row = yield* rowOf(instanceId);
        expect(row?.syncStatus).toBe('pending');
        expect((yield* listOps).map((op) => op.kind)).toEqual(['rsvp']);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    'an occurrence edit after a rule change that still draws it starts from its exception',
    () =>
      Effect.gen(function* () {
        yield* seedMaster;
        yield* (yield* EventRepo).upsertMany([override]);
        const mutations = yield* EventMutations;
        // The new rule still has July 4: Google keeps its exception (verified live).
        yield* mutations.updateRecurring({
          ...target,
          changes: { recurrence: ['RRULE:FREQ=DAILY;COUNT=12'] },
          scope: 'series',
        });
        expect((yield* rowOf(instanceId))?.title).toBe('Daily (moved)');

        yield* mutations.updateRecurring({
          ...target,
          changes: { location: 'Room 4' },
          scope: 'instance',
        });
        const edit = (yield* listOps).find(
          (op) => op.eventId === instanceId && op.kind === 'update',
        );
        expect(edit?.payload?.title).toBe('Daily (moved)');
        expect(edit?.payload?.location).toBe('Room 4');
        expect(edit?.beforePayload?.title).toBe('Daily (moved)');
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect('a series delete brings the master and its exceptions back', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      yield* (yield* EventRepo).upsertMany([override]);
      const mutations = yield* EventMutations;
      yield* mutations.deleteRecurring({ ...target, scope: 'series' });
      expect(yield* rowOf('master1')).toBeNull();
      expect(yield* rowOf(instanceId)).toBeNull();
      const [op] = yield* listOps;
      expect(op?.beforeOverrides?.map((row) => row.id)).toEqual([instanceId]);

      yield* mutations.discardPendingOp(op!.id);
      expect((yield* rowOf('master1'))?.title).toBe('Daily');
      expect((yield* rowOf('master1'))?.syncStatus).toBe('synced');
      expect((yield* rowOf(instanceId))?.title).toBe('Daily (moved)');
      expect(yield* listOps).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe('keeping a series a pull put back while its delete waits', () => {
  // Cancelled on Google: the series delete took its tombstone along, and
  // an incremental pull re-sent only the master, which changed. Dropped
  // with the delete, the tombstone was gone for good and July 4 showed.
  const cancelled = new EventRecord({
    ...master,
    etag: '"o-1"',
    id: instanceId,
    originalStartUtc: occurrence,
    recurrence: undefined,
    recurringEventId: 'master1',
    startUtc: occurrence,
    status: 'cancelled',
  });
  const deleteThenPull = (copy: EventRecord, exception: EventRecord = cancelled) =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      yield* events.upsertMany([exception]);
      yield* (yield* EventMutations).deleteRecurring({ ...target, scope: 'series' });
      expect(yield* rowOf(instanceId)).toBeNull();
      yield* events.upsertMany([copy], { mode: 'pull' });
    });
  const pulled = new EventRecord({ ...master, etag: '"m-2"', title: 'Daily (Google)' });

  it.effect('a series edit brings back the exceptions the delete took', () =>
    Effect.gen(function* () {
      yield* deleteThenPull(pulled);
      yield* (yield* EventMutations).updateRecurring({
        ...target,
        changes: { location: 'Room 4' },
        scope: 'series',
      });
      expect((yield* listOps).map((op) => op.kind)).toEqual(['update']);
      const row = yield* rowOf(instanceId);
      expect(row?.status).toBe('cancelled');
      expect(row?.syncStatus).toBe('synced');
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('so does an answer', () =>
    Effect.gen(function* () {
      yield* deleteThenPull(
        new EventRecord({
          ...pulled,
          attendees: [
            new Attendee({
              email: 'acc-1@example.com',
              isSelf: true,
              responseStatus: 'needsAction',
            }),
            new Attendee({
              email: 'host@example.com',
              isOrganizer: true,
              responseStatus: 'accepted',
            }),
          ],
          organizerEmail: 'host@example.com',
        }),
      );
      yield* (yield* EventMutations).respondToEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: 'master1',
        response: 'accepted',
      });
      expect((yield* listOps).map((op) => op.kind)).toEqual(['rsvp']);
      expect((yield* rowOf(instanceId))?.status).toBe('cancelled');
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('so does deleting this and following', () =>
    Effect.gen(function* () {
      yield* deleteThenPull(pulled);
      yield* (yield* EventMutations).deleteRecurring({
        ...target,
        originalStartUtc: Date.parse('2026-07-07T09:00:00Z'),
        scope: 'following',
      });
      const ops = yield* listOps;
      expect(ops.map((op) => op.kind)).toEqual(['update']);
      // The cut diffs against Google's master, not the one the delete saw.
      expect(ops[0]?.beforePayload?.title).toBe('Daily (Google)');
      expect((yield* rowOf(instanceId))?.status).toBe('cancelled');
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('a series edit diffs against Google’s master: a discard shows it again', () =>
    Effect.gen(function* () {
      yield* deleteThenPull(pulled);
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { location: 'Room 4' },
        scope: 'series',
      });
      const [op] = yield* listOps;
      expect(op?.beforePayload?.title).toBe('Daily (Google)');

      yield* mutations.discardPendingOp(op!.id);
      const row = yield* rowOf('master1');
      expect(row?.title).toBe('Daily (Google)');
      expect(row?.location).toBeUndefined();
      expect(row?.etag).toBe('"m-2"');
      expect(row?.syncStatus).toBe('synced');
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('a second series delete takes them into its own snapshot', () =>
    Effect.gen(function* () {
      yield* deleteThenPull(pulled);
      const mutations = yield* EventMutations;
      yield* mutations.deleteRecurring({ ...target, scope: 'series' });
      const [op] = yield* listOps;
      expect(op?.beforePayload?.title).toBe('Daily (Google)');
      expect(op?.beforeOverrides?.map((row) => row.id)).toEqual([instanceId]);

      yield* mutations.discardPendingOp(op!.id);
      const row = yield* rowOf('master1');
      expect(row?.title).toBe('Daily (Google)');
      expect(row?.etag).toBe('"m-2"');
      expect((yield* rowOf(instanceId))?.status).toBe('cancelled');
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('and a move takes them along', () =>
    Effect.gen(function* () {
      yield* deleteThenPull(pulled);
      yield* (yield* CalendarRepo).upsertMany([
        new CalendarInfo({
          accessRole: 'owner',
          accountId: 'acc-1',
          colorHex: '#3b82f6',
          id: 'cal-2',
          isPrimary: false,
          isVisible: true,
          provider: 'google',
          summary: 'Home',
          timeZone: 'Europe/Vienna',
        }),
      ]);
      yield* (yield* EventMutations).moveEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: 'master1',
        target: { accountId: 'acc-1', calendarId: 'cal-2' },
      });
      expect((yield* listOps).map((op) => op.kind)).toEqual(['move']);
      const events = yield* EventRepo;
      expect(yield* events.getById('acc-1', 'cal-1', instanceId)).toBeNull();
      expect((yield* events.getById('acc-1', 'cal-2', instanceId))?.status).toBe('cancelled');
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  describe('one occurrence of it, changed meanwhile', () => {
    // An exception on Google: two hours later, under its own title.
    const moved = new EventRecord({
      ...cancelled,
      endUtc: Date.parse('2026-07-04T12:00:00Z'),
      startUtc: Date.parse('2026-07-04T11:00:00Z'),
      status: 'confirmed',
      title: 'Daily (moved)',
    });
    // Only the occurrence delete reaches Google; the series delete stays offline.
    const occurrenceLands = testLayerWith({
      ...stubClient,
      deleteEvent: ({ eventId }) =>
        eventId === instanceId
          ? Effect.void
          : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
    });
    const seriesDelete = Effect.map(listOps, (ops) => ops.find((op) => op.eventId === 'master1'));

    it.effect('stays deleted when the series delete is discarded before it lands', () =>
      Effect.gen(function* () {
        yield* deleteThenPull(pulled, moved);
        const mutations = yield* EventMutations;
        yield* mutations.deleteRecurring({ ...target, scope: 'instance' });
        yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
        expect((yield* listOps).map((op) => op.eventId)).toEqual([instanceId]);
        expect((yield* rowOf(instanceId))?.status).toBe('cancelled');

        yield* mutations.processPendingOps();
        expect(yield* listOps).toEqual([]);
        expect((yield* rowOf(instanceId))?.status).toBe('cancelled');
      }).pipe(noYield, Effect.provide(occurrenceLands)),
    );

    it.effect('and after it landed', () =>
      Effect.gen(function* () {
        yield* deleteThenPull(pulled, moved);
        const mutations = yield* EventMutations;
        yield* mutations.deleteRecurring({ ...target, scope: 'instance' });
        yield* mutations.processPendingOps();
        expect((yield* listOps).map((op) => op.eventId)).toEqual(['master1']);

        yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
        expect((yield* rowOf(instanceId))?.status).toBe('cancelled');
      }).pipe(noYield, Effect.provide(occurrenceLands)),
    );

    it.effect('its delete takes the exception as Google has it: a discard shows it again', () =>
      Effect.gen(function* () {
        yield* deleteThenPull(pulled, moved);
        const mutations = yield* EventMutations;
        yield* mutations.deleteRecurring({ ...target, scope: 'instance' });
        const remove = (yield* listOps).find((op) => op.eventId === instanceId);
        expect(remove?.beforePayload?.title).toBe('Daily (moved)');
        expect(remove?.baseEtag).toBe('"o-1"');

        yield* mutations.discardPendingOp(remove!.id);
        const row = yield* rowOf(instanceId);
        expect(row?.status).toBe('confirmed');
        expect(row?.title).toBe('Daily (moved)');
        expect(row?.startUtc).toBe(moved.startUtc);
      }).pipe(noYield, Effect.provide(testLayer)),
    );

    it.effect('an edit of it patches that exception, and the discard keeps the edit', () =>
      Effect.gen(function* () {
        yield* deleteThenPull(pulled, moved);
        const mutations = yield* EventMutations;
        yield* mutations.updateRecurring({
          ...target,
          changes: { location: 'Room 4' },
          scope: 'instance',
        });
        const edit = (yield* listOps).find((op) => op.eventId === instanceId);
        // Not the master's slot and title: the patch would move it back.
        expect(edit?.payload?.title).toBe('Daily (moved)');
        expect(edit?.payload?.startUtc).toBe(moved.startUtc);
        expect(edit?.beforePayload?.title).toBe('Daily (moved)');
        expect(edit?.baseEtag).toBe('"o-1"');

        yield* mutations.discardPendingOp((yield* seriesDelete)!.id);
        const row = yield* rowOf(instanceId);
        expect(row?.location).toBe('Room 4');
        expect(row?.syncStatus).toBe('pending');
      }).pipe(noYield, Effect.provide(testLayer)),
    );

    it.effect('once the series delete lands, the exception put back for it goes too', () =>
      Effect.gen(function* () {
        yield* deleteThenPull(pulled, moved);
        const mutations = yield* EventMutations;
        yield* mutations.deleteRecurring({ ...target, scope: 'instance' });
        const remove = (yield* listOps).find((op) => op.eventId === instanceId);
        yield* mutations.discardPendingOp(remove!.id);
        expect((yield* rowOf(instanceId))?.syncStatus).toBe('synced');

        // Without its master the exception would show as an event of its own.
        yield* mutations.processPendingOps();
        expect(yield* listOps).toEqual([]);
        expect(yield* rowOf('master1')).toBeNull();
        expect(yield* rowOf(instanceId)).toBeNull();
      }).pipe(
        noYield,
        Effect.provide(testLayerWith({ ...stubClient, deleteEvent: () => Effect.void })),
      ),
    );

    // Only the series delete reaches Google; the occurrence's op stays offline.
    const seriesLands = testLayerWith({
      ...stubClient,
      deleteEvent: ({ eventId }) =>
        eventId === 'master1'
          ? Effect.void
          : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
      patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
    });

    it.effect('a discard after the series delete landed puts nothing back', () =>
      Effect.gen(function* () {
        yield* deleteThenPull(pulled, moved);
        const mutations = yield* EventMutations;
        yield* mutations.deleteRecurring({ ...target, scope: 'instance' });
        yield* mutations.processPendingOps();
        const [remove] = yield* listOps;
        expect(remove?.eventId).toBe(instanceId);

        // Google deleted the exception with its series.
        yield* mutations.discardPendingOp(remove!.id);
        expect(yield* rowOf(instanceId)).toBeNull();
      }).pipe(noYield, Effect.provide(seriesLands)),
    );

    it.effect('nor does one of an edit of it', () =>
      Effect.gen(function* () {
        yield* deleteThenPull(pulled, moved);
        const mutations = yield* EventMutations;
        yield* mutations.updateRecurring({
          ...target,
          changes: { location: 'Room 4' },
          scope: 'instance',
        });
        yield* mutations.processPendingOps();
        const [edit] = yield* listOps;
        expect(edit?.eventId).toBe(instanceId);

        yield* mutations.discardPendingOp(edit!.id);
        expect(yield* rowOf(instanceId)).toBeNull();
      }).pipe(noYield, Effect.provide(seriesLands)),
    );
  });

  it.effect('an edit of an occurrence Google cancelled still starts from the slot', () =>
    Effect.gen(function* () {
      // The series delete took July 4's cancellation: the slot shows.
      yield* deleteThenPull(pulled);
      yield* (yield* EventMutations).updateRecurring({
        ...target,
        changes: { location: 'Room 4' },
        scope: 'instance',
      });
      const edit = (yield* listOps).find((op) => op.eventId === instanceId);
      expect(edit?.payload?.status).toBe('confirmed');
      expect(edit?.payload?.title).toBe('Daily (Google)');
      expect((yield* rowOf(instanceId))?.status).toBe('confirmed');
    }).pipe(noYield, Effect.provide(testLayer)),
  );
});

describe('an exception of a series whose delete waits', () => {
  /** What the calendar draws July 1–10: "MM-DDTHH:MM title" per event. */
  const shown = Effect.gen(function* () {
    const from = Date.parse('2026-07-01T00:00:00Z');
    const to = Date.parse('2026-07-11T00:00:00Z');
    const window = yield* (yield* EventRepo).getWindow(from, to);
    return assembleWindow(window, from, to).map(
      (event) => `${new Date(event.startUtc).toISOString().slice(5, 16)} ${event.title}`,
    );
  });
  // July 4 moved to 11:00, and an invitation the user answers.
  const invited = new EventRecord({
    ...master,
    attendees: [
      new Attendee({ email: 'acc-1@example.com', isSelf: true, responseStatus: 'needsAction' }),
      new Attendee({ email: 'host@example.com', isOrganizer: true, responseStatus: 'accepted' }),
    ],
    endUtc: Date.parse('2026-07-04T12:00:00Z'),
    etag: '"o-1"',
    id: instanceId,
    organizerEmail: 'host@example.com',
    originalStartUtc: occurrence,
    recurrence: undefined,
    recurringEventId: 'master1',
    startUtc: Date.parse('2026-07-04T11:00:00Z'),
    title: 'Daily (moved)',
  });
  const answered = {
    attendees: [
      { email: 'acc-1@example.com', responseStatus: 'accepted', self: true },
      { email: 'host@example.com', organizer: true, responseStatus: 'accepted' },
    ],
    end: { dateTime: '2026-07-04T12:00:00Z' },
    etag: '"o-2"',
    id: instanceId,
    organizer: { email: 'host@example.com' },
    originalStartTime: { dateTime: '2026-07-04T09:00:00Z' },
    recurringEventId: 'master1',
    start: { dateTime: '2026-07-04T11:00:00Z', timeZone: 'UTC' },
    status: 'confirmed',
    summary: 'Daily (moved)',
  };

  it.effect('an answer that lands meanwhile keeps it out of sight, for a discard', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      yield* (yield* EventRepo).upsertMany([invited]);
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: instanceId,
        response: 'accepted',
      });
      // The answer survives the series delete and lands while it waits.
      yield* mutations.deleteRecurring({ ...target, scope: 'series' });
      yield* mutations.processPendingOps();
      const [remove] = yield* listOps;
      expect(remove?.kind).toBe('delete');
      // Written back, the exception showed as an event without its series.
      expect(yield* shown).toEqual([]);
      expect(remove?.beforeOverrides?.map((row) => row.etag)).toEqual(['"o-2"']);

      yield* discardAsUntried(remove!.id);
      expect(yield* shown).toContain('07-04T11:00 Daily (moved)');
      const row = yield* rowOf(instanceId);
      expect(row?.etag).toBe('"o-2"');
      expect(row?.syncStatus).toBe('synced');
      expect(row?.attendees?.find((guest) => guest.isSelf)?.responseStatus).toBe('accepted');
    }).pipe(
      noYield,
      Effect.provide(testLayerWith({ ...stubClient, patchEvent: () => Effect.succeed(answered) })),
    ),
  );

  it.effect('an answer discarded meanwhile is out of what a discard of the delete puts back', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      yield* (yield* EventRepo).upsertMany([invited]);
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: instanceId,
        response: 'accepted',
      });
      yield* mutations.deleteRecurring({ ...target, scope: 'series' });
      const ops = yield* listOps;
      yield* mutations.discardPendingOp(ops.find((op) => op.kind === 'rsvp')!.id);
      yield* mutations.discardPendingOp(ops.find((op) => op.kind === 'delete')!.id);

      // Google never got the answer.
      const row = yield* rowOf(instanceId);
      expect(row?.syncStatus).toBe('synced');
      expect(row?.attendees?.find((guest) => guest.isSelf)?.responseStatus).toBe('needsAction');
    }).pipe(
      noYield,
      Effect.provide(
        testLayerWith({
          ...stubClient,
          patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        }),
      ),
    ),
  );

  it.effect('one discarded over Google’s copy of the occurrence leaves that copy', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      yield* (yield* EventRepo).upsertMany([invited]);
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: instanceId,
        response: 'accepted',
      });
      yield* mutations.deleteRecurring({ ...target, scope: 'instance' });
      // A pull leaves the tombstone: Google's copy, accepted on another
      // device, is what the occurrence delete puts back now.
      const google = new EventRecord({
        ...invited,
        attendees: invited.attendees?.map((guest) =>
          guest.isSelf ? new Attendee({ ...guest, responseStatus: 'accepted' }) : guest,
        ),
        etag: '"o-2"',
      });
      const queue = yield* PendingOpRepo;
      const waiting = (yield* queue.listAll()).find((op) => op.kind === 'delete');
      yield* queue.setBefore(waiting!.id, google);
      yield* mutations.deleteRecurring({ ...target, scope: 'series' });

      const ops = yield* listOps;
      yield* mutations.discardPendingOp(ops.find((op) => op.kind === 'rsvp')!.id);
      yield* mutations.discardPendingOp(ops.find((op) => op.eventId === 'master1')!.id);
      const row = yield* rowOf(instanceId);
      expect(row?.etag).toBe('"o-2"');
      expect(row?.attendees?.find((guest) => guest.isSelf)?.responseStatus).toBe('accepted');
    }).pipe(
      noYield,
      Effect.provide(
        testLayerWith({
          ...stubClient,
          patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        }),
      ),
    ),
  );

  it.effect('keep theirs on the parked delete brings the exceptions back with the master', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      // July 6 cancelled on Google.
      const cancelled = new EventRecord({
        ...invited,
        attendees: undefined,
        id: 'master1_20260706T090000Z',
        organizerEmail: undefined,
        originalStartUtc: Date.parse('2026-07-06T09:00:00Z'),
        startUtc: Date.parse('2026-07-06T09:00:00Z'),
        status: 'cancelled',
      });
      yield* (yield* EventRepo).upsertMany([invited, cancelled]);
      const mutations = yield* EventMutations;
      yield* mutations.deleteRecurring({ ...target, scope: 'series' });
      yield* mutations.processPendingOps();
      const [parked] = yield* listOps;
      expect(parked?.conflictAt).toBeDefined();

      yield* mutations.resolveConflict({ choice: 'theirs', opId: parked!.id });
      expect(yield* listOps).toEqual([]);
      expect(yield* shown).toEqual([
        '07-01T09:00 Daily (Google)',
        '07-02T09:00 Daily (Google)',
        '07-03T09:00 Daily (Google)',
        '07-04T11:00 Daily (moved)',
        '07-05T09:00 Daily (Google)',
        '07-07T09:00 Daily (Google)',
        '07-08T09:00 Daily (Google)',
        '07-09T09:00 Daily (Google)',
        '07-10T09:00 Daily (Google)',
      ]);
    }).pipe(
      noYield,
      Effect.provide(
        testLayerWith({
          ...stubClient,
          // Renamed on Google since: the delete parks.
          deleteEvent: ({ calendarId, eventId }) =>
            Effect.fail(new ConflictError({ calendarId, eventId })),
          getEvent: () =>
            Effect.succeed({
              end: { dateTime: '2026-07-01T10:00:00Z', timeZone: 'UTC' },
              etag: '"m-2"',
              id: 'master1',
              recurrence: ['RRULE:FREQ=DAILY;COUNT=10'],
              start: { dateTime: '2026-07-01T09:00:00Z', timeZone: 'UTC' },
              status: 'confirmed',
              summary: 'Daily (Google)',
            }),
        }),
      ),
    ),
  );
});

describe('EventMutations: a series keeps its kind', () => {
  /** The July 4 occurrence as the editor sends it after the all-day switch. */
  const allDayTimes = {
    endDate: '2026-07-05',
    endUtc: plainDateToUtcMs('2026-07-05'),
    isAllDay: true,
    startDate: '2026-07-04',
    startUtc: plainDateToUtcMs('2026-07-04'),
  };

  it.effect('refuses to switch an occurrence or the series between timed and all-day', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      for (const scope of ['instance', 'following', 'series'] as const) {
        const error = yield* Effect.flip(
          mutations.updateRecurring({ ...target, changes: allDayTimes, scope }),
        );
        expect(error._tag).toBe('RecurringAllDaySwitchError');
      }
      const events = yield* EventRepo;
      expect(yield* events.getById('acc-1', 'cal-1', 'master1')).toEqual(master);
      expect(yield* events.getById('acc-1', 'cal-1', instanceId)).toBeNull();
      expect(yield* listOps).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('moves an all-day series one occurrence at a time, and says so', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      const allDay = new EventRecord({
        ...master,
        endDate: '2026-07-02',
        endUtc: plainDateToUtcMs('2026-07-02'),
        id: 'allday1',
        isAllDay: true,
        startDate: '2026-07-01',
        startTimeZone: undefined,
        startUtc: plainDateToUtcMs('2026-07-01'),
      });
      yield* events.upsertMany([allDay]);
      const mutations = yield* EventMutations;
      const slot = {
        ...target,
        masterId: 'allday1',
        originalStartUtc: plainDateToUtcMs('2026-07-04'),
      };
      const nextDay = {
        endDate: '2026-07-06',
        endUtc: plainDateToUtcMs('2026-07-06'),
        isAllDay: true,
        startDate: '2026-07-05',
        startUtc: plainDateToUtcMs('2026-07-05'),
      };
      for (const scope of ['following', 'series'] as const) {
        const error = yield* Effect.flip(
          mutations.updateRecurring({ ...slot, changes: nextDay, scope }),
        );
        expect(error._tag).toBe('RecurringAllDayMoveError');
      }
      expect(yield* listOps).toEqual([]);

      // Same date, new title: the series takes it.
      yield* mutations.updateRecurring({
        ...slot,
        changes: { ...allDayTimes, title: 'Renamed' },
        scope: 'series',
      });
      expect((yield* events.getById('acc-1', 'cal-1', 'allday1'))!.title).toBe('Renamed');

      // One occurrence moves.
      yield* mutations.updateRecurring({ ...slot, changes: nextDay, scope: 'instance' });
      const moved = yield* events.getById('acc-1', 'cal-1', 'allday1_20260704');
      expect(moved!.startDate).toBe('2026-07-05');

      // Its exception's date, not its slot's, is the one it shows: a
      // this-and-following edit there that keeps the date is no move, and
      // the new series starts on the slot without contradicting itself.
      yield* mutations.updateRecurring({
        ...slot,
        changes: { ...nextDay, title: 'From here' },
        scope: 'following',
      });
      const window = yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'));
      const split = window.masters.find((event) => event.title === 'From here');
      expect(split!.startDate).toBe('2026-07-04');
      expect(split!.startUtc).toBe(plainDateToUtcMs('2026-07-04'));
    }).pipe(Effect.provide(testLayer)),
  );
});

describe('EventMutations: a series Google has not seen yet', () => {
  const createSeries = Effect.gen(function* () {
    yield* seedMaster;
    return yield* (yield* EventMutations).createEvent({
      accountId: 'acc-1',
      calendarId: 'cal-1',
      endUtc: master.endUtc,
      isAllDay: false,
      recurrence: ['RRULE:FREQ=DAILY;COUNT=10'],
      startTimeZone: 'UTC',
      startUtc: master.startUtc,
      title: 'Fresh',
    });
  });

  it.effect('a series edit rides in the queued create instead of a patch that would 404', () =>
    Effect.gen(function* () {
      const created = yield* createSeries;
      const [create] = yield* listOps;
      yield* (yield* EventMutations).updateRecurring({
        ...target,
        changes: { title: 'Renamed' },
        masterId: created.id,
        scope: 'series',
      });
      const ops = yield* listOps;
      expect(ops.map((op) => `${op.kind}:${op.eventId}`)).toEqual([`create:${created.id}`]);
      expect(ops[0]!.payload?.title).toBe('Renamed');
      // Its place in the queue: occurrence edits queued after it still wait.
      expect(ops[0]!.createdAt).toBe(create!.createdAt);
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('this-and-following truncates inside the create and creates the new half', () =>
    Effect.gen(function* () {
      const created = yield* createSeries;
      yield* (yield* EventMutations).updateRecurring({
        ...target,
        changes: { title: 'Later' },
        masterId: created.id,
        scope: 'following',
      });
      const ops = yield* listOps;
      expect(ops.map((op) => op.kind)).toEqual(['create', 'create']);
      expect(ops[0]!.eventId).toBe(created.id);
      expect(ops[0]!.payload?.recurrence).toEqual(['RRULE:FREQ=DAILY;UNTIL=20260704T085959Z']);
      expect(ops[1]!.payload?.title).toBe('Later');
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('deleting it queues nothing; deleting from an occurrence on truncates the create', () =>
    Effect.gen(function* () {
      const created = yield* createSeries;
      const mutations = yield* EventMutations;
      const events = yield* EventRepo;
      yield* mutations.deleteRecurring({ ...target, masterId: created.id, scope: 'following' });
      const ops = yield* listOps;
      expect(ops.map((op) => op.kind)).toEqual(['create']);
      expect(ops[0]!.payload?.recurrence).toEqual(['RRULE:FREQ=DAILY;UNTIL=20260704T085959Z']);

      yield* mutations.deleteRecurring({ ...target, masterId: created.id, scope: 'series' });
      expect(yield* listOps).toEqual([]);
      expect(yield* events.getById('acc-1', 'cal-1', created.id)).toBeNull();
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('an occurrence edit waits for the create instead of 404ing and being dropped', () =>
    Effect.gen(function* () {
      const created = yield* createSeries;
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Just this one' },
        masterId: created.id,
        scope: 'instance',
      });
      // The stub insert fails, so the create stays queued ahead of it.
      yield* mutations.processPendingOps();
      const instance = (yield* listOps).find((op) => op.eventId !== created.id);
      expect(instance?.kind).toBe('update');
      expect(instance?.lastError).toBe('waiting for the create ahead of it');
      const events = yield* EventRepo;
      expect(
        (yield* events.getById('acc-1', 'cal-1', `${created.id}_20260704T090000Z`))?.title,
      ).toBe('Just this one');
    }).pipe(noYield, Effect.provide(testLayer)),
  );

  it.effect('a sent create may be on Google: series edits and deletes queue behind it', () =>
    Effect.gen(function* () {
      const created = yield* createSeries;
      const ops = yield* PendingOpRepo;
      const [create] = yield* ops.listAll();
      // The insert went out; its response never came back.
      yield* ops.markDispatched(create!.id, 1);
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Renamed' },
        masterId: created.id,
        scope: 'series',
      });
      expect((yield* ops.listAll()).map((op) => op.kind)).toEqual(['create', 'update']);
      expect((yield* ops.listAll())[0]!.payload?.title).toBe('Fresh');

      yield* mutations.deleteRecurring({ ...target, masterId: created.id, scope: 'following' });
      expect((yield* ops.listAll()).map((op) => op.kind)).toEqual(['create', 'update']);
      expect((yield* ops.listAll())[1]!.payload?.recurrence).toEqual([
        'RRULE:FREQ=DAILY;UNTIL=20260704T085959Z',
      ]);

      yield* mutations.deleteRecurring({ ...target, masterId: created.id, scope: 'series' });
      // The delete is sent after the create, whatever Google made of it.
      expect((yield* ops.listAll()).map((op) => op.kind)).toEqual(['create', 'delete']);
    }).pipe(noYield, Effect.provide(testLayer)),
  );
});

describe('EventMutations recurrence rule edits', () => {
  const override = new EventRecord({
    ...master,
    etag: '"o-1"',
    id: instanceId,
    originalStartUtc: occurrence,
    recurrence: undefined,
    recurringEventId: 'master1',
    title: 'Daily (this one moved)',
  });

  it.effect('a series takes the new rule and drops its exceptions', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      yield* events.upsertMany([override]);
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'] },
        scope: 'series',
      });
      const updated = yield* events.getById('acc-1', 'cal-1', 'master1');
      expect(updated!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;COUNT=4']);
      expect(updated!.startUtc).toBe(master.startUtc);
      // The exception belonged to the old rule's occurrences.
      expect(yield* events.getById('acc-1', 'cal-1', instanceId)).toBeNull();
      const ops = yield* listOps;
      expect(ops.map((op) => op.kind)).toEqual(['update']);
      const update = ops.find((op) => op.kind === 'update')!;
      expect(update.beforeOverrides?.map((copy) => copy.id)).toEqual([instanceId]);
      expect(update.payload?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;COUNT=4']);
      expect(update.recurrenceCleared).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('new times drop the exceptions and the queued changes of their occurrences', () =>
    // Verified live 2026-11-22: a new start cancels every exception whose
    // slot is no longer drawn; a new end alone keeps them.
    Effect.gen(function* () {
      yield* seedMaster;
      yield* (yield* EventRepo).upsertMany([override]);
      const mutations = yield* EventMutations;
      // A waiting change of that occurrence, made before the retime.
      yield* mutations.updateRecurring({
        ...target,
        changes: { location: 'Room 2' },
        scope: 'instance',
      });
      const series = { ...target, originalStartUtc: master.startUtc, scope: 'series' as const };
      yield* mutations.updateRecurring({
        ...series,
        changes: { endUtc: master.endUtc + 30 * 60_000, startUtc: master.startUtc },
      });
      expect((yield* rowOf(instanceId))?.location).toBe('Room 2');
      expect((yield* listOps).map((op) => `${op.kind} ${op.eventId}`).sort()).toEqual([
        'update master1',
        `update ${instanceId}`,
      ]);

      yield* mutations.updateRecurring({
        ...series,
        changes: {
          endUtc: master.endUtc + 60 * 60_000,
          startUtc: master.startUtc + 60 * 60_000,
        },
      });
      expect(yield* rowOf(instanceId)).toBeNull();
      const ops = yield* listOps;
      expect(ops.map((op) => `${op.kind} ${op.eventId}`)).toEqual(['update master1']);
      // Google's copy of it, without the change that waited.
      expect(ops[0]?.beforeOverrides?.map((copy) => [copy.id, copy.location])).toEqual([
        [instanceId, undefined],
      ]);

      // Given up, the series and the exception are back as Google has them.
      yield* mutations.discardPendingOp(ops[0]!.id);
      expect((yield* rowOf('master1'))?.startUtc).toBe(master.startUtc);
      const back = yield* rowOf(instanceId);
      expect([back?.title, back?.location, back?.syncStatus]).toEqual([
        'Daily (this one moved)',
        undefined,
        'synced',
      ]);
      expect(yield* listOps).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('a new rule keeps the exceptions whose slots it still draws, as Google does', () =>
    Effect.gen(function* () {
      const cancelled = new EventRecord({
        ...override,
        etag: '"o-2"',
        id: 'master1_20260705T090000Z',
        originalStartUtc: Date.parse('2026-07-05T09:00:00Z'),
        startUtc: Date.parse('2026-07-05T09:00:00Z'),
        status: 'cancelled',
      });
      const pastTheEnd = new EventRecord({
        ...override,
        etag: '"o-3"',
        id: 'master1_20260709T090000Z',
        originalStartUtc: Date.parse('2026-07-09T09:00:00Z'),
        startUtc: Date.parse('2026-07-09T11:00:00Z'),
      });
      yield* seedMaster;
      yield* (yield* EventRepo).upsertMany([override, cancelled, pastTheEnd]);
      yield* (yield* EventMutations).updateRecurring({
        ...target,
        changes: { recurrence: ['RRULE:FREQ=DAILY;COUNT=7'] },
        scope: 'series',
      });
      // July 4 and July 5 are slots of the new rule: Google keeps their
      // exceptions (verified live). July 9 is past its end: Google cancels it.
      expect((yield* rowOf(instanceId))?.title).toBe('Daily (this one moved)');
      expect((yield* rowOf(cancelled.id))?.status).toBe('cancelled');
      expect(yield* rowOf(pastTheEnd.id)).toBeNull();
      const ops = yield* listOps;
      expect(ops.map((op) => `${op.kind} ${op.eventId}`)).toEqual(['update master1']);
      expect(ops[0]?.beforeOverrides?.map((copy) => copy.id)).toEqual([pastTheEnd.id]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('"does not repeat" on a series leaves one event and sends an empty rule', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { recurrence: null, title: 'Once' },
        scope: 'series',
      });
      const events = yield* EventRepo;
      const updated = yield* events.getById('acc-1', 'cal-1', 'master1');
      expect(updated!.recurrence).toBeUndefined();
      expect(updated!.title).toBe('Once');
      expect(updated!.startUtc).toBe(master.startUtc);
      const ops = yield* listOps;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.kind).toBe('update');
      expect(ops[0]!.recurrenceCleared).toBe(true);
      expect(ops[0]!.payload?.recurrence).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    '"does not repeat" from an occurrence on ends the series there and keeps it alone',
    () =>
      Effect.gen(function* () {
        yield* seedMaster;
        const mutations = yield* EventMutations;
        yield* mutations.updateRecurring({
          ...target,
          changes: { recurrence: null },
          scope: 'following',
        });
        const events = yield* EventRepo;
        const truncated = yield* events.getById('acc-1', 'cal-1', 'master1');
        expect(truncated!.recurrence).toEqual(['RRULE:FREQ=DAILY;UNTIL=20260704T085959Z']);
        const window = yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'));
        const single = window.singles.find((event) => event.id !== 'master1');
        expect(single).toBeDefined();
        expect(single!.recurrence).toBeUndefined();
        expect(single!.recurringEventId).toBeUndefined();
        expect(single!.startUtc).toBe(occurrence);
        const ops = yield* listOps;
        expect(ops.map((op) => op.kind).sort()).toEqual(['create', 'update']);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect('a this-and-following edit can give the split-off half its own rule', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] },
        scope: 'following',
      });
      const events = yield* EventRepo;
      const window = yield* events.getWindow(0, plainDateToUtcMs('2030-01-01'));
      const newMaster = window.masters.find((event) => event.id !== 'master1');
      expect(newMaster!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;COUNT=3']);
      expect(newMaster!.startUtc).toBe(occurrence);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('one occurrence cannot carry a rule, and a single event cannot take one', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      yield* events.upsertMany([
        new EventRecord({ ...master, id: 'single1', recurrence: undefined }),
      ]);
      const mutations = yield* EventMutations;
      const instance = yield* Effect.flip(
        mutations.updateRecurring({
          ...target,
          changes: { recurrence: ['RRULE:FREQ=WEEKLY'] },
          scope: 'instance',
        }),
      );
      expect(instance._tag).toBe('RecurringEditUnsupportedError');
      const single = yield* Effect.flip(
        mutations.updateEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          changes: { recurrence: ['RRULE:FREQ=WEEKLY'] },
          eventId: 'single1',
        }),
      );
      expect(single._tag).toBe('RecurringEditUnsupportedError');
      expect(yield* listOps).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe('a cleared series edited again before it synced', () => {
  it.effect('keeps clearing the rule on Google when a later edit replaces the queued op', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const mutations = yield* EventMutations;
      yield* mutations.updateRecurring({
        ...target,
        changes: { recurrence: null },
        scope: 'series',
      });
      // Locally a single event now, so the plain update path takes it.
      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Once, renamed' },
        eventId: 'master1',
      });
      const ops = yield* listOps;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.payload?.title).toBe('Once, renamed');
      expect(ops[0]!.payload?.recurrence).toBeUndefined();
      expect(ops[0]!.recurrenceCleared).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
