import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
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
  ApiUnavailableError,
  ConflictError,
  type GcalEventPatch,
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
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
        insertCalendar: () => Effect.die('not used'),
        insertEvent: () => Effect.die('unexpected insert'),
        listCalendars: () => Effect.succeed({ items: [] }),
        listEvents: () => Effect.succeed({ items: [] }),
        moveEvent: () => Effect.die('unexpected move'),
        patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
        patchEvent: () => Effect.die('unexpected patch'),
        replaceEvent: () => Effect.die('not used'),
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
      provider: 'google',
      summary: 'Work',
      timeZone: 'UTC',
    }),
  ]);
  const events = yield* EventRepo;
  yield* events.upsertMany([invited]);
});

const respond = { accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-invite' } as const;

/**
 * Google's copy of the invitation with a real If-Match check: a stale
 * etag is a 412, and write n produces etag "wn". `sent` reads
 * "<fields> <If-Match or unchecked> → <new etag or 412>".
 */
const ifMatchGoogle = (initialEtag: string, { firstEditFails = false } = {}) => {
  const sent: Array<string> = [];
  let etag = initialEtag;
  let writes = 0;
  let editFails = firstEditFails;
  // Only the fields the tests change: a PATCH body's nulls are not a stored event.
  const current = (patch: GcalEventPatch = {}) => ({
    attendees:
      patch.attendees ??
      invited.attendees?.map((attendee) => ({
        email: attendee.email,
        responseStatus: attendee.responseStatus,
      })),
    end: { dateTime: '2026-07-08T11:00:00Z' },
    etag,
    id: 'evt-invite',
    start: { dateTime: '2026-07-08T10:00:00Z', timeZone: 'UTC' },
    status: 'confirmed' as const,
    summary: typeof patch.summary === 'string' ? patch.summary : 'Planning',
  });
  const client: Partial<GoogleCalendarClientShape> = {
    getEvent: () => Effect.sync(() => current()),
    patchEvent: ({ baseEtag, event, eventId }) =>
      Effect.suspend((): ReturnType<GoogleCalendarClientShape['patchEvent']> => {
        const fields = 'summary' in event ? 'summary' : 'attendees';
        const check = baseEtag === undefined ? 'unchecked' : `If-Match ${baseEtag}`;
        if (fields === 'summary' && editFails) {
          editFails = false;
          sent.push(`${fields} ${check} → offline`);
          return Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
        }
        if (baseEtag !== undefined && baseEtag !== etag) {
          sent.push(`${fields} ${check} → 412`);
          return Effect.fail(new ConflictError({ calendarId: 'cal-1', eventId }));
        }
        writes += 1;
        etag = `"w${writes}"`;
        sent.push(`${fields} ${check} → ${etag}`);
        return Effect.succeed(current(event));
      }),
  };
  return { client, sent };
};

describe('EventMutations.respondToEvent', () => {
  it.effect('updates only the own attendee and patches attendees-only', () => {
    const patches: Array<GcalEventPatch> = [];
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

  it.effect('an edit queued behind an RSVP follows the etag it produced', () => {
    const google = ifMatchGoogle('"inv-1"');
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
      yield* mutations.updateEvent({ ...respond, changes: { title: 'Planning v2' } });
      yield* mutations.processPendingOps();
      yield* mutations.processPendingOps();

      // The RSVP's If-Match held, so the edit went out on the etag it
      // produced instead of meeting a 412 against the user's own RSVP.
      expect(google.sent).toEqual([
        'attendees If-Match "inv-1" → "w1"',
        'summary If-Match "w1" → "w2"',
      ]);
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
    }).pipe(Effect.provide(makeLayer(google.client)));
  });

  it.effect('an RSVP lands when Google moved on; the edit behind it still asks', () => {
    // Another client changed the event after it was pulled.
    const google = ifMatchGoogle('"remote"');
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
      yield* mutations.updateEvent({ ...respond, changes: { title: 'Planning v2' } });
      yield* mutations.processPendingOps();
      yield* mutations.processPendingOps();

      expect(google.sent).toEqual([
        'attendees If-Match "inv-1" → 412',
        'attendees unchecked → "w1"',
        'summary If-Match "inv-1" → 412',
      ]);
      const [parked] = yield* (yield* PendingOpRepo).listAll();
      expect(parked?.kind).toBe('update');
      expect(parked?.conflictAt).toBeDefined();
    }).pipe(Effect.provide(makeLayer(google.client)));
  });

  it.effect('an edit queued before an RSVP that overtook it keeps its etag and asks', () => {
    // The guest-list edit carries the response the RSVP then replaced: on
    // the RSVP's etag it would land and quietly undo the RSVP.
    const google = ifMatchGoogle('"inv-1"', { firstEditFails: true });
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const pending = yield* PendingOpRepo;
      yield* mutations.updateEvent({
        ...respond,
        changes: {
          attendees: [
            ...invited.attendees!.map((attendee) => ({ email: attendee.email })),
            { email: 'new@example.com' },
          ],
        },
      });
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
      // The edit goes offline into backoff; the RSVP lands meanwhile.
      yield* mutations.processPendingOps();
      for (const op of yield* pending.listAll()) {
        yield* pending.markFailed(op.id, op.attempts, 0, 'test');
      }
      yield* mutations.processPendingOps();

      expect(google.sent).toEqual([
        'summary If-Match "inv-1" → offline',
        'attendees If-Match "inv-1" → "w1"',
        'summary If-Match "inv-1" → 412',
      ]);
      const [parked] = yield* pending.listAll();
      expect(parked?.kind).toBe('update');
      expect(parked?.conflictAt).toBeDefined();
    }).pipe(Effect.provide(makeLayer(google.client)));
  });

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
