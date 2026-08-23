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
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
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

const makeLayer = (overrides: Partial<GoogleCalendarClientShape>) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(
      Layer.succeed(GoogleCalendarClient, {
        deleteEvent: () => Effect.void,
        getColors: () => Effect.succeed({ calendar: {} }),
        insertEvent: () => Effect.die('unexpected insert'),
        listCalendars: () => Effect.succeed({ items: [] }),
        listEvents: () => Effect.succeed({ items: [] }),
        patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
        patchEvent: () => Effect.die('unexpected patch'),
        ...overrides,
      }),
    ),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, stubTasksClient)),
  );

const invited = new EventRecord({
  accountId: 'acc-1',
  attendees: [
    new Attendee({ email: 'organizer@example.com', isOrganizer: true, responseStatus: 'accepted' }),
    new Attendee({ email: 'nik@nikgraf.com', responseStatus: 'needsAction' }),
  ],
  calendarId: 'cal-1',
  endUtc: Date.parse('2026-07-08T11:00:00Z'),
  etag: '"inv-1"',
  id: 'evt-invite',
  isAllDay: false,
  startTimeZone: 'UTC',
  startUtc: Date.parse('2026-07-08T10:00:00Z'),
  status: 'confirmed',
  syncedAt: 1,
  syncStatus: 'synced',
  title: 'Planning',
  updatedAt: 1,
});

const seed = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  yield* accounts.upsert(
    new Account({
      createdAt: 1,
      email: 'nik@nikgraf.com',
      id: 'acc-1',
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
  yield* events.upsertMany([invited]);
});

const respond = { accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-invite' } as const;

describe('EventMutations.respondToEvent', () => {
  it.effect('updates only the own attendee and patches attendees-only', () => {
    const patches: Array<Partial<GcalEventInput>> = [];
    const layer = makeLayer({
      patchEvent: ({ event }) => {
        patches.push(event);
        return Effect.succeed({
          attendees: event.attendees?.map((attendee) => ({ ...attendee })),
          end: { dateTime: '2026-07-08T11:00:00Z' },
          etag: '"inv-2"',
          id: 'evt-invite',
          start: { dateTime: '2026-07-08T10:00:00Z', timeZone: 'UTC' },
          status: 'confirmed',
          summary: 'Planning',
        });
      },
    });
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });

      const events = yield* EventRepo;
      const row = yield* events.getById('acc-1', 'cal-1', 'evt-invite');
      expect(
        row!.attendees!.find((attendee) => attendee.email === 'nik@nikgraf.com')!.responseStatus,
      ).toBe('accepted');
      expect(
        row!.attendees!.find((attendee) => attendee.email === 'organizer@example.com')!
          .responseStatus,
      ).toBe('accepted');

      yield* mutations.processPendingOps();
      expect(patches).toHaveLength(1);
      // Attendees-only body — no times/summary that could clobber the server copy.
      expect(Object.keys(patches[0]!)).toEqual(['attendees']);
      expect(patches[0]!.attendees).toEqual([
        { email: 'organizer@example.com', responseStatus: 'accepted' },
        { email: 'nik@nikgraf.com', responseStatus: 'accepted' },
      ]);

      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect('a later content edit does not coalesce away the queued RSVP', () =>
    Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({ ...respond, response: 'declined' });
      yield* mutations.respondToEvent({ ...respond, response: 'tentative' });
      yield* mutations.updateEvent({ ...respond, changes: { title: 'Planning v2' } });

      const ops = yield* (yield* PendingOpRepo).listAll();
      // The two RSVPs collapse to one; the update op sits alongside it.
      expect(ops.map((op) => op.kind).sort()).toEqual(['rsvp', 'update']);
      const rsvpOp = ops.find((op) => op.kind === 'rsvp');
      expect(
        rsvpOp?.payload?.attendees?.find((attendee) => attendee.email === 'nik@nikgraf.com')
          ?.responseStatus,
      ).toBe('tentative');
    }).pipe(Effect.provide(makeLayer({}))),
  );

  it.effect('fails when the account is not on the guest list', () =>
    Effect.gen(function* () {
      yield* seed;
      const events = yield* EventRepo;
      yield* events.upsertMany([
        new EventRecord({ ...invited, attendees: undefined, id: 'evt-solo' }),
      ]);
      const mutations = yield* EventMutations;
      const exit = yield* Effect.exit(
        mutations.respondToEvent({ ...respond, eventId: 'evt-solo', response: 'accepted' }),
      );
      expect(exit._tag).toBe('Failure');
    }).pipe(Effect.provide(makeLayer({}))),
  );
});
