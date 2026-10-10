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
import { describe } from 'vite-plus/test';
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
    new Attendee({ email: 'nik@example.com', responseStatus: 'needsAction' }),
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
      email: 'nik@example.com',
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
        row!.attendees!.find((attendee) => attendee.email === 'nik@example.com')!.responseStatus,
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
        { email: 'nik@example.com', responseStatus: 'accepted' },
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
        rsvpOp?.payload?.attendees?.find((attendee) => attendee.email === 'nik@example.com')
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

describe('discarding an edit of an invitation', () => {
  it.effect('keeps the answer given before it and leaves the row to the queued RSVP', () =>
    Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
      yield* mutations.updateEvent({ ...respond, changes: { title: 'Planning v2' } });
      const queue = yield* PendingOpRepo;
      const edit = (yield* queue.listAll()).find((op) => op.kind === 'update');
      expect(edit?.beforePayload?.title).toBe('Planning');

      yield* mutations.discardPendingOp(edit!.id);
      const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-invite');
      expect(row?.title).toBe('Planning');
      const own = row?.attendees?.find((attendee) => attendee.email === 'nik@example.com');
      expect(own?.responseStatus).toBe('accepted');
      // The RSVP still owns the row: pulls must keep skipping it.
      expect(row?.syncStatus).toBe('pending');
      expect((yield* queue.listAll()).map((op) => op.kind)).toEqual(['rsvp']);
    }).pipe(
      Effect.provide(
        makeLayer({ patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })) }),
      ),
    ),
  );
});

describe('discarding a rename and an RSVP made offline, in either order', () => {
  const offline = makeLayer({
    patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
  });
  const rowNow = Effect.gen(function* () {
    const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-invite');
    const own = row?.attendees?.find((attendee) => attendee.email === 'nik@example.com');
    return { response: own?.responseStatus, syncStatus: row?.syncStatus, title: row?.title };
  });

  it.effect('puts back only what each change did: neither resurrects the other', () =>
    Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const queue = yield* PendingOpRepo;
      const opOf = (kind: 'rsvp' | 'update') =>
        Effect.map(queue.listAll(), (ops) => ops.find((op) => op.kind === kind)!.id);
      // Rename, then RSVP: the RSVP's snapshot carries the new title.
      yield* mutations.updateEvent({ ...respond, changes: { title: 'Planning v2' } });
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
      yield* mutations.discardPendingOp(yield* opOf('update'));
      expect(yield* rowNow).toEqual({
        response: 'accepted',
        syncStatus: 'pending',
        title: 'Planning',
      });
      yield* mutations.discardPendingOp(yield* opOf('rsvp'));
      expect(yield* rowNow).toEqual({
        response: 'needsAction',
        syncStatus: 'synced',
        title: 'Planning',
      });
      expect(yield* queue.listAll()).toEqual([]);

      // RSVP, then rename: the rename's snapshot carries the answer.
      yield* mutations.respondToEvent({ ...respond, response: 'tentative' });
      yield* mutations.updateEvent({ ...respond, changes: { title: 'Planning v3' } });
      yield* mutations.discardPendingOp(yield* opOf('rsvp'));
      expect(yield* rowNow).toEqual({
        response: 'needsAction',
        syncStatus: 'pending',
        title: 'Planning v3',
      });
      yield* mutations.discardPendingOp(yield* opOf('update'));
      expect(yield* rowNow).toEqual({
        response: 'needsAction',
        syncStatus: 'synced',
        title: 'Planning',
      });
      expect(yield* queue.listAll()).toEqual([]);
    }).pipe(Effect.provide(offline)),
  );
});

/** The id of the queued op of this kind (one at most: they coalesce). */
const queuedOpOf = (kind: 'rsvp' | 'update') =>
  Effect.map(
    Effect.flatMap(PendingOpRepo, (queue) => queue.listAll()),
    (ops) => ops.find((op) => op.kind === kind)!.id,
  );

describe('an RSVP and an edit queued around each other own different fields', () => {
  const offline = makeLayer({
    patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
  });
  const rowNow = Effect.gen(function* () {
    const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-invite');
    const own = row?.attendees?.find((attendee) => attendee.email === 'nik@example.com');
    return { response: own?.responseStatus, syncStatus: row?.syncStatus, title: row?.title };
  });

  it.effect('a second RSVP discarded puts back only its answer, not the rename between', () =>
    Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
      yield* mutations.updateEvent({ ...respond, changes: { title: 'Planning v2' } });
      yield* mutations.respondToEvent({ ...respond, response: 'tentative' });
      yield* mutations.discardPendingOp(yield* queuedOpOf('rsvp'));
      expect(yield* rowNow).toEqual({
        response: 'needsAction',
        syncStatus: 'pending',
        title: 'Planning v2',
      });
      yield* mutations.discardPendingOp(yield* queuedOpOf('update'));
      expect(yield* rowNow).toEqual({
        response: 'needsAction',
        syncStatus: 'synced',
        title: 'Planning',
      });
    }).pipe(Effect.provide(offline)),
  );

  it.effect('a second rename discarded leaves the answer given between the two renames', () =>
    Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.updateEvent({ ...respond, changes: { title: 'Planning v2' } });
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
      yield* mutations.updateEvent({ ...respond, changes: { title: 'Planning v3' } });
      yield* mutations.discardPendingOp(yield* queuedOpOf('update'));
      expect(yield* rowNow).toEqual({
        response: 'accepted',
        syncStatus: 'pending',
        title: 'Planning',
      });
      yield* mutations.discardPendingOp(yield* queuedOpOf('rsvp'));
      expect(yield* rowNow).toEqual({
        response: 'needsAction',
        syncStatus: 'synced',
        title: 'Planning',
      });
    }).pipe(Effect.provide(offline)),
  );
});

describe('an RSVP discarded after a delete took the row', () => {
  it.effect('comes out of the delete’s snapshot, so discarding the delete does not keep it', () =>
    Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
      yield* mutations.deleteEvent(respond);
      const queue = yield* PendingOpRepo;
      const rsvp = (yield* queue.listAll()).find((op) => op.kind === 'rsvp');
      yield* mutations.discardPendingOp(rsvp!.id);
      const remove = (yield* queue.listAll()).find((op) => op.kind === 'delete');
      const own = remove?.beforePayload?.attendees?.find(
        (attendee) => attendee.email === 'nik@example.com',
      );
      expect(own?.responseStatus).toBe('needsAction');

      yield* mutations.discardPendingOp(remove!.id);
      const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-invite');
      expect(
        row?.attendees?.find((attendee) => attendee.email === 'nik@example.com')?.responseStatus,
      ).toBe('needsAction');
      expect(row?.syncStatus).toBe('synced');
    }).pipe(
      Effect.provide(
        makeLayer({
          deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
          patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
        }),
      ),
    ),
  );
});

/** The account's own answer in a record's guest list. */
const ownResponseOf = (
  record: { readonly attendees?: ReadonlyArray<Attendee> | undefined } | undefined,
) => record?.attendees?.find((attendee) => attendee.email === 'nik@example.com')?.responseStatus;

describe('a discarded change leaves what the other queued op sends', () => {
  const offline = makeLayer({
    patchEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
  });

  it.effect('a discarded RSVP is not sent along by a queued guest-list edit', () =>
    Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
      yield* mutations.updateEvent({
        ...respond,
        changes: {
          attendees: [
            new Attendee({
              email: 'organizer@example.com',
              isOrganizer: true,
              responseStatus: 'accepted',
            }),
            new Attendee({ email: 'nik@example.com', responseStatus: 'accepted' }),
            new Attendee({ email: 'ann@example.com', responseStatus: 'needsAction' }),
          ],
        },
      });
      const queue = yield* PendingOpRepo;
      const rsvp = (yield* queue.listAll()).find((op) => op.kind === 'rsvp');
      yield* mutations.discardPendingOp(rsvp!.id);
      const edit = (yield* queue.listAll()).find((op) => op.kind === 'update');
      expect(edit?.attendeesChanged).toBe(true);
      expect(ownResponseOf(edit?.payload)).toBe('needsAction');
      expect(
        edit?.payload?.attendees?.some((attendee) => attendee.email === 'ann@example.com'),
      ).toBe(true);
    }).pipe(Effect.provide(offline)),
  );

  it.effect('a discarded guest-list edit is not sent along by a queued RSVP', () =>
    Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.updateEvent({
        ...respond,
        changes: {
          attendees: [
            new Attendee({
              email: 'organizer@example.com',
              isOrganizer: true,
              responseStatus: 'accepted',
            }),
            new Attendee({ email: 'nik@example.com', responseStatus: 'needsAction' }),
            new Attendee({ email: 'ann@example.com', responseStatus: 'needsAction' }),
          ],
        },
      });
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
      const queue = yield* PendingOpRepo;
      const edit = (yield* queue.listAll()).find((op) => op.kind === 'update');
      yield* mutations.discardPendingOp(edit!.id);
      const rsvp = (yield* queue.listAll()).find((op) => op.kind === 'rsvp');
      expect(ownResponseOf(rsvp?.payload)).toBe('accepted');
      expect(
        rsvp?.payload?.attendees?.some((attendee) => attendee.email === 'ann@example.com'),
      ).toBe(false);
    }).pipe(Effect.provide(offline)),
  );
});
