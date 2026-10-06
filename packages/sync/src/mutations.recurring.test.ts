import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import {
  Account,
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
  ApiUnavailableError,
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
  SyncTokenExpiredError,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer, Scheduler } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vitest';
import { EventMutations } from './mutations.ts';

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

  it.effect('a series edit carries changed text fields onto the exceptions, like Google', () =>
    Effect.gen(function* () {
      yield* seedMaster;
      const events = yield* EventRepo;
      // An exception with its own title and location.
      yield* events.upsertMany([
        new EventRecord({
          ...master,
          endUtc: occurrence + 60 * 60 * 1000,
          etag: '"o-1"',
          id: instanceId,
          location: 'Room 4',
          originalStartUtc: occurrence,
          recurrence: undefined,
          recurringEventId: 'master1',
          startUtc: occurrence,
          title: 'Daily (moved)',
        }),
      ]);
      const mutations = yield* EventMutations;
      // Only the title changes: Google copies it onto the exception and
      // leaves the exception's own location alone.
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Standup' },
        scope: 'series',
      });
      const exception = yield* events.getById('acc-1', 'cal-1', instanceId);
      expect(exception!.title).toBe('Standup');
      expect(exception!.location).toBe('Room 4');
      // No op for the exception: Google updates it itself.
      expect((yield* listOps).map((op) => op.eventId)).toEqual(['master1']);
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
