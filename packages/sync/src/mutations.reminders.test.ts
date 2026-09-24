import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import {
  Account,
  CalendarInfo,
  EventRecord,
  EventReminders,
  ReminderOverride,
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
  type GcalEventPatch,
  type GcalTimePatch,
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer, Scheduler } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { EventMutations } from './mutations.ts';

const stubTasksClient: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('tasks not used in this test'),
  insertTask: () => Effect.die('tasks not used in this test'),
  listTaskLists: () => Effect.die('tasks not used in this test'),
  listTasks: () => Effect.die('tasks not used in this test'),
  patchTask: () => Effect.die('tasks not used in this test'),
};

// See mutations.attendees.test.ts: the detached drain must not run
// between two mutations of one test body.
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

interface Sent {
  readonly event: GcalEventPatch;
  readonly kind: 'insert' | 'patch';
}

// Echoes what was sent, like Google: a stale start would turn the next
// following-scope edit into a series edit.
/** A patched time as Google stores it: the nulled fields are gone. */
const stored = (time: GcalTimePatch | undefined) =>
  time && Object.fromEntries(Object.entries(time).filter(([, value]) => typeof value === 'string'));

const echo = (event: GcalEventPatch, id: string) =>
  Effect.succeed({
    end: stored(event.end) ?? { dateTime: '2026-07-08T11:00:00Z' },
    etag: '"next"',
    id,
    recurrence: event.recurrence,
    reminders: event.reminders ?? { useDefault: true },
    start: stored(event.start) ?? { dateTime: '2026-07-08T10:00:00Z', timeZone: 'UTC' },
    status: 'confirmed',
    summary: event.summary ?? 'Planning',
  });

const makeLayer = (sent: Array<Sent>, overrides: Partial<GoogleCalendarClientShape> = {}) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(
      Layer.succeed(GoogleCalendarClient, {
        deleteEvent: () => Effect.void,
        getColors: () => Effect.succeed({ calendar: {} }),
        getEvent: () => Effect.die('unexpected get'),
        insertEvent: ({ event }) => {
          sent.push({ event, kind: 'insert' });
          return echo(event, event.id ?? 'server-id');
        },
        listCalendars: () => Effect.succeed({ items: [] }),
        listEvents: () => Effect.succeed({ items: [] }),
        moveEvent: () => Effect.die('unexpected move'),
        patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
        patchEvent: ({ event, eventId }) => {
          sent.push({ event, kind: 'patch' });
          return echo(event, eventId);
        },
        ...overrides,
      }),
    ),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, stubTasksClient)),
  );

const popup = (minutes: number) => new ReminderOverride({ method: 'popup', minutes });
const email = (minutes: number) => new ReminderOverride({ method: 'email', minutes });

const custom = new EventReminders({ overrides: [email(60), popup(30)], useDefault: false });
const customWire = {
  overrides: [
    { method: 'email', minutes: 60 },
    { method: 'popup', minutes: 30 },
  ],
  useDefault: false,
};

const single = new EventRecord({
  accountId: 'acc-1',
  calendarId: 'cal-1',
  endUtc: Date.parse('2026-07-08T11:00:00Z'),
  etag: '"s-1"',
  id: 'evt-single',
  isAllDay: false,
  reminders: custom,
  startTimeZone: 'UTC',
  startUtc: Date.parse('2026-07-08T10:00:00Z'),
  status: 'confirmed',
  syncedAt: 1,
  syncStatus: 'synced',
  title: 'Planning',
  updatedAt: 1,
});

const master = new EventRecord({
  ...single,
  endUtc: Date.parse('2026-07-01T10:00:00Z'),
  etag: '"m-1"',
  id: 'master1',
  recurrence: ['RRULE:FREQ=DAILY;COUNT=10'],
  reminders: undefined,
  startUtc: Date.parse('2026-07-01T09:00:00Z'),
});

const seed = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  yield* accounts.upsert(
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'nik@nikgraf.com',
      id: 'acc-1',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  );
  const calendars = yield* CalendarRepo;
  yield* calendars.upsertMany([
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-1',
      colorHex: '#3b82f6',
      defaultReminders: [popup(10)],
      id: 'cal-1',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: 'UTC',
    }),
  ]);
  const events = yield* EventRepo;
  yield* events.upsertMany([single, master]);
});

const target = { accountId: 'acc-1', calendarId: 'cal-1' } as const;
const rowOf = (id: string) =>
  Effect.flatMap(EventRepo, (events) => events.getById('acc-1', 'cal-1', id));

describe('EventMutations reminders', () => {
  it.effect('createEvent stores the canonical reminders and inserts them', () => {
    const sent: Array<Sent> = [];
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent({
        ...target,
        endUtc: Date.parse('2026-07-09T11:00:00Z'),
        isAllDay: false,
        reminders: { overrides: [email(60), popup(30), popup(30)], useDefault: false },
        startTimeZone: 'UTC',
        startUtc: Date.parse('2026-07-09T10:00:00Z'),
        title: 'Kickoff',
      });
      expect(record.reminders).toEqual(custom);
      yield* mutations.processPendingOps();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.event.reminders).toEqual(customWire);
    }).pipe(noYield, Effect.provide(makeLayer(sent)));
  });

  it.effect(
    'a create without reminders sends no reminders key (Google applies its default)',
    () => {
      const sent: Array<Sent> = [];
      return Effect.gen(function* () {
        yield* seed;
        const mutations = yield* EventMutations;
        yield* mutations.createEvent({
          ...target,
          endUtc: Date.parse('2026-07-09T11:00:00Z'),
          isAllDay: false,
          startTimeZone: 'UTC',
          startUtc: Date.parse('2026-07-09T10:00:00Z'),
          title: 'Focus',
        });
        yield* mutations.processPendingOps();
        expect('reminders' in sent[0]!.event).toBe(false);
      }).pipe(noYield, Effect.provide(makeLayer(sent)));
    },
  );

  it.effect('updateEvent patches the reminders only when the edit touched them', () => {
    const sent: Array<Sent> = [];
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      // An unrelated edit: the row keeps its reminders, the patch omits them.
      yield* mutations.updateEvent({
        ...target,
        changes: { title: 'Planning (renamed)' },
        eventId: 'evt-single',
      });
      expect((yield* rowOf('evt-single'))?.reminders).toEqual(custom);
      yield* mutations.processPendingOps();
      expect(sent).toHaveLength(1);
      expect('reminders' in sent[0]!.event).toBe(false);

      // "None" is a value of its own, distinct from the calendar default.
      const none = new EventReminders({ overrides: [], useDefault: false });
      yield* mutations.updateEvent({
        ...target,
        changes: { reminders: none },
        eventId: 'evt-single',
      });
      expect((yield* rowOf('evt-single'))?.reminders).toEqual(none);
      yield* mutations.processPendingOps();
      expect(sent[1]!.event.reminders).toEqual({ overrides: [], useDefault: false });
    }).pipe(noYield, Effect.provide(makeLayer(sent)));
  });

  it.effect('the flag survives a later unrelated edit coalescing the queued update', () => {
    const sent: Array<Sent> = [];
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const reset = new EventReminders({ overrides: [], useDefault: true });
      yield* mutations.updateEvent({
        ...target,
        changes: { reminders: reset },
        eventId: 'evt-single',
      });
      yield* mutations.updateEvent({
        ...target,
        changes: { title: 'Later' },
        eventId: 'evt-single',
      });
      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops).toHaveLength(1);
      expect(ops[0]!.remindersChanged).toBe(true);
      yield* mutations.processPendingOps();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.event.reminders).toEqual({ overrides: [], useDefault: true });
      expect(sent[0]!.event.summary).toBe('Later');
    }).pipe(noYield, Effect.provide(makeLayer(sent)));
  });

  it.effect('a reminders edit folds into a still-queued create', () => {
    const sent: Array<Sent> = [];
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent({
        ...target,
        endUtc: Date.parse('2026-07-09T11:00:00Z'),
        isAllDay: false,
        startTimeZone: 'UTC',
        startUtc: Date.parse('2026-07-09T10:00:00Z'),
        title: 'Kickoff',
      });
      yield* mutations.updateEvent({
        ...target,
        changes: { reminders: custom },
        eventId: record.id,
      });
      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops.map((op) => op.kind)).toEqual(['create']);
      expect(ops[0]!.remindersChanged).toBeUndefined();
      expect(ops[0]!.payload?.reminders).toEqual(custom);
    }).pipe(
      noYield,
      Effect.provide(
        makeLayer(sent, { insertEvent: () => Effect.die('the drain must not run in this test') }),
      ),
    );
  });

  it.effect(
    'series and instance edits carry reminders; following copies them to the new master',
    () => {
      const sent: Array<Sent> = [];
      return Effect.gen(function* () {
        yield* seed;
        const mutations = yield* EventMutations;
        const occurrence = Date.parse('2026-07-04T09:00:00Z');
        const recurring = { ...target, masterId: 'master1', originalStartUtc: occurrence };

        yield* mutations.updateRecurring({
          ...recurring,
          changes: { reminders: custom },
          scope: 'series',
        });
        expect((yield* rowOf('master1'))?.reminders).toEqual(custom);
        yield* mutations.processPendingOps();
        expect(sent.at(-1)!.event.reminders).toEqual(customWire);

        const none = new EventReminders({ overrides: [], useDefault: false });
        yield* mutations.updateRecurring({
          ...recurring,
          changes: { reminders: none },
          scope: 'instance',
        });
        expect((yield* rowOf('master1_20260704T090000Z'))?.reminders).toEqual(none);
        yield* mutations.processPendingOps();
        expect(sent.at(-1)!.event.reminders).toEqual({ overrides: [], useDefault: false });

        yield* mutations.updateRecurring({
          ...recurring,
          changes: { title: 'Split' },
          scope: 'following',
        });
        yield* mutations.processPendingOps();
        const inserted = sent.find((entry) => entry.kind === 'insert');
        expect(inserted?.event.reminders).toEqual(customWire);
      }).pipe(noYield, Effect.provide(makeLayer(sent)));
    },
  );
});
