import { Account, Attendee, CalendarInfo, EventRecord } from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  PendingOpRepo,
  reposLayer,
  runMigrations,
} from '@calendar/db';
import {
  type GcalEventInput,
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

/**
 * Mutations fork the queue drain detached; a fiber yield between two
 * mutations would let it push the first before the second coalesces it.
 * The default yield cadence moves with every migration, so pin it: each
 * test body runs to its own explicit processPendingOps without yielding.
 */
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

interface Sent {
  readonly event: Partial<GcalEventInput>;
  readonly kind: 'insert' | 'patch';
  readonly sendUpdates: 'all' | undefined;
}

const echo = (event: Partial<GcalEventInput>, id: string) =>
  Effect.succeed({
    attendees: event.attendees?.map((attendee) => ({ ...attendee })),
    end: { dateTime: '2026-07-08T11:00:00Z' },
    etag: '"next"',
    id,
    start: { dateTime: '2026-07-08T10:00:00Z', timeZone: 'UTC' },
    status: 'confirmed',
    summary: event.summary ?? 'Planning',
  });

const makeLayer = (sent: Array<Sent>, overrides: Partial<GoogleCalendarClientShape> = {}) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(
      Layer.succeed(GoogleCalendarClient, {
        deleteEvent: () => Effect.void,
        getColors: () => Effect.succeed({ calendar: {} }),
        insertEvent: ({ event, sendUpdates }) => {
          sent.push({ event, kind: 'insert', sendUpdates });
          return echo(event, event.id ?? 'server-id');
        },
        listCalendars: () => Effect.succeed({ items: [] }),
        listEvents: () => Effect.succeed({ items: [] }),
        patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
        patchEvent: ({ event, eventId, sendUpdates }) => {
          sent.push({ event, kind: 'patch', sendUpdates });
          return echo(event, eventId);
        },
        ...overrides,
      }),
    ),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, stubTasksClient)),
  );

const meeting = new EventRecord({
  accountId: 'acc-1',
  attendees: [
    new Attendee({
      email: 'nik@nikgraf.com',
      isOrganizer: true,
      isSelf: true,
      responseStatus: 'accepted',
    }),
    new Attendee({
      displayName: 'Alice',
      email: 'alice@example.com',
      responseStatus: 'tentative',
    }),
  ],
  calendarId: 'cal-1',
  endUtc: Date.parse('2026-07-08T11:00:00Z'),
  etag: '"m-1"',
  id: 'evt-meeting',
  isAllDay: false,
  startTimeZone: 'UTC',
  startUtc: Date.parse('2026-07-08T10:00:00Z'),
  status: 'confirmed',
  syncedAt: 1,
  syncStatus: 'synced',
  title: 'Planning',
  updatedAt: 1,
});

const solo = new EventRecord({ ...meeting, attendees: undefined, etag: '"s-1"', id: 'evt-solo' });

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
      id: 'cal-1',
      isPrimary: true,
      isVisible: true,
      summary: 'Work',
      timeZone: 'UTC',
    }),
  ]);
  const events = yield* EventRepo;
  yield* events.upsertMany([meeting, solo]);
});

const target = { accountId: 'acc-1', calendarId: 'cal-1' } as const;
const emails = (attendees: ReadonlyArray<{ readonly email: string }> | undefined) =>
  attendees?.map((attendee) => attendee.email);

describe('EventMutations attendees', () => {
  it.effect('createEvent carries guests as needsAction and inserts with sendUpdates=all', () => {
    const sent: Array<Sent> = [];
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const record = yield* mutations.createEvent({
        ...target,
        attendees: [{ displayName: 'Bob', email: 'bob@example.com' }],
        endUtc: Date.parse('2026-07-09T11:00:00Z'),
        isAllDay: false,
        startTimeZone: 'UTC',
        startUtc: Date.parse('2026-07-09T10:00:00Z'),
        title: 'Kickoff',
      });
      expect(record.attendees).toEqual([
        new Attendee({
          displayName: 'Bob',
          email: 'bob@example.com',
          responseStatus: 'needsAction',
        }),
      ]);

      yield* mutations.processPendingOps();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.kind).toBe('insert');
      expect(sent[0]!.sendUpdates).toBe('all');
      expect(sent[0]!.event.attendees).toEqual([
        { displayName: 'Bob', email: 'bob@example.com', responseStatus: 'needsAction' },
      ]);
    }).pipe(noYield, Effect.provide(makeLayer(sent)));
  });

  it.effect('a guestless create sends no attendees key and no sendUpdates', () => {
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
      expect(sent[0]!.sendUpdates).toBeUndefined();
      expect('attendees' in sent[0]!.event && sent[0]!.event.attendees !== undefined).toBe(false);
    }).pipe(noYield, Effect.provide(makeLayer(sent)));
  });

  it.effect('updateEvent replaces the list but keeps responses of retained guests', () => {
    const sent: Array<Sent> = [];
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.updateEvent({
        ...target,
        changes: {
          attendees: [
            { email: 'nik@nikgraf.com' },
            { email: 'ALICE@example.com' },
            { email: 'carol@example.com' },
          ],
        },
        eventId: 'evt-meeting',
      });

      const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-meeting');
      expect(emails(row!.attendees)).toEqual([
        'nik@nikgraf.com',
        'alice@example.com',
        'carol@example.com',
      ]);
      const alice = row!.attendees!.find((attendee) => attendee.email === 'alice@example.com');
      expect(alice).toMatchObject({ displayName: 'Alice', responseStatus: 'tentative' });
      expect(row!.attendees![0]).toMatchObject({ isOrganizer: true, responseStatus: 'accepted' });

      yield* mutations.processPendingOps();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.kind).toBe('patch');
      expect(sent[0]!.sendUpdates).toBe('all');
      expect(emails(sent[0]!.event.attendees)).toEqual([
        'nik@nikgraf.com',
        'alice@example.com',
        'carol@example.com',
      ]);
    }).pipe(noYield, Effect.provide(makeLayer(sent)));
  });

  it.effect('an empty list clears the guests and still notifies them', () => {
    const sent: Array<Sent> = [];
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.updateEvent({
        ...target,
        changes: { attendees: [] },
        eventId: 'evt-meeting',
      });
      yield* mutations.processPendingOps();
      expect(sent[0]!.event.attendees).toEqual([]);
      expect(sent[0]!.sendUpdates).toBe('all');
    }).pipe(noYield, Effect.provide(makeLayer(sent)));
  });

  it.effect(
    'a content edit on a meeting notifies guests but leaves the attendee array alone',
    () => {
      const sent: Array<Sent> = [];
      return Effect.gen(function* () {
        yield* seed;
        const mutations = yield* EventMutations;
        yield* mutations.updateEvent({
          ...target,
          changes: { title: 'Planning v2' },
          eventId: 'evt-meeting',
        });
        yield* mutations.updateEvent({
          ...target,
          changes: { title: 'Solo v2' },
          eventId: 'evt-solo',
        });
        yield* mutations.processPendingOps();
        const byTitle = (title: string) => sent.find((entry) => entry.event.summary === title)!;
        // Google replaces the whole array: a title patch must not carry it,
        // or a room (never in our copy's editor view) would be dropped.
        expect('attendees' in byTitle('Planning v2').event).toBe(false);
        expect(byTitle('Planning v2').sendUpdates).toBe('all');
        expect('attendees' in byTitle('Solo v2').event).toBe(false);
        expect(byTitle('Solo v2').sendUpdates).toBeUndefined();
      }).pipe(noYield, Effect.provide(makeLayer(sent)));
    },
  );

  it.effect(
    'a guest edit keeps the room booking and a later title edit keeps the guest edit',
    () => {
      const sent: Array<Sent> = [];
      return Effect.gen(function* () {
        yield* seed;
        const events = yield* EventRepo;
        yield* events.upsertMany([
          new EventRecord({
            ...meeting,
            attendees: [
              ...meeting.attendees!,
              new Attendee({
                email: 'room@resource.calendar.google.com',
                isResource: true,
                responseStatus: 'accepted',
              }),
            ],
            id: 'evt-room',
          }),
        ]);
        const mutations = yield* EventMutations;
        yield* mutations.updateEvent({
          ...target,
          changes: { attendees: [{ email: 'nik@nikgraf.com' }, { email: 'bob@example.com' }] },
          eventId: 'evt-room',
        });
        // Coalesces into one op that still carries the guest edit.
        yield* mutations.updateEvent({
          ...target,
          changes: { title: 'Roomy' },
          eventId: 'evt-room',
        });
        const ops = yield* (yield* PendingOpRepo).listAll();
        expect(ops).toHaveLength(1);
        expect(ops[0]!.attendeesChanged).toBe(true);

        yield* mutations.processPendingOps();
        expect(sent).toHaveLength(1);
        expect(sent[0]!.event.summary).toBe('Roomy');
        expect(emails(sent[0]!.event.attendees)).toEqual([
          'nik@nikgraf.com',
          'bob@example.com',
          'room@resource.calendar.google.com',
        ]);
        expect(sent[0]!.event.attendees?.[2]).toMatchObject({
          resource: true,
          responseStatus: 'accepted',
        });
      }).pipe(noYield, Effect.provide(makeLayer(sent)));
    },
  );

  it.effect('a guest edit folds into a still-queued create', () => {
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
        changes: { attendees: [{ email: 'bob@example.com' }] },
        eventId: record.id,
      });
      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops.map((op) => op.kind)).toEqual(['create']);
      expect(emails(ops[0]!.payload?.attendees)).toEqual(['bob@example.com']);
    }).pipe(
      noYield,
      Effect.provide(
        makeLayer(sent, { insertEvent: () => Effect.die('the drain must not run in this test') }),
      ),
    );
  });
});
