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
import { Effect, Layer, Scheduler } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import { EventMutations } from './mutations.ts';

const stubTasksClient: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('tasks not used in this test'),
  insertTask: () => Effect.die('tasks not used in this test'),
  listTaskLists: () => Effect.die('tasks not used in this test'),
  listTasks: () => Effect.die('tasks not used in this test'),
  moveTask: () => Effect.die('tasks not used in this test'),
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
        // An answer names the guests alone, as many as were invited; an
        // edit names what it changed: a title, or a longer guest list.
        const fields =
          'summary' in event || event.attendees?.length !== invited.attendees?.length
            ? 'summary'
            : 'attendees';
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

/** Keeps the drain a mutation forks from running before the next call. */
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

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

  it.effect(
    'an RSVP lands when Google moved on; the edit behind it goes on Google’s version',
    () => {
      // Another client changed the event after it was pulled, in nothing
      // the edit changes. The answer goes again unchecked, and its reply
      // is Google's version now: the edit is laid over it and goes on its
      // etag, and nobody is asked.
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
          'summary If-Match "w1" → "w2"',
        ]);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }).pipe(Effect.provide(makeLayer(google.client)));
    },
  );

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
      // Neither change is tried in between: a delete that was tried waits
      // for Google's word when it is discarded (`finishDiscard`).
      noYield,
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

  it.effect(
    'a discarded RSVP is not sent along by the edit that replaced one queued before it',
    () =>
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
        // Replaces the guest-list edit where it waits, ahead of the answer.
        yield* mutations.updateEvent({ ...respond, changes: { title: 'Planning v2' } });
        const queue = yield* PendingOpRepo;
        expect((yield* queue.listAll()).map((op) => op.kind)).toEqual(['update', 'rsvp']);
        const rsvp = (yield* queue.listAll()).find((op) => op.kind === 'rsvp');
        yield* mutations.discardPendingOp(rsvp!.id);
        const edit = (yield* queue.listAll()).find((op) => op.kind === 'update');
        expect(ownResponseOf(edit?.payload)).toBe('needsAction');
        expect(edit?.payload?.title).toBe('Planning v2');
        const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-invite');
        expect(ownResponseOf(row ?? undefined)).toBe('needsAction');
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

describe('an answer waiting under a newer rename', () => {
  it.effect(
    'a rename that lands before an older answer keeps its title, also in what follows',
    () => {
      // Review (Opus): the answer was queued on a row that showed a rename
      // and kept that title among its changes. A newer rename replaced the
      // first and landed while the answer still backed off: the row was drawn
      // again from the answer, old title and all, and the next edit of what
      // the user saw sent that title to Google as theirs.
      const sent: Array<string> = [];
      let offline = true;
      let etag = '"inv-1"';
      let writes = 0;
      let summary = 'Planning';
      let description: string | undefined = undefined;
      let attendees = invited.attendees!.map((attendee) => ({
        email: attendee.email,
        responseStatus: attendee.responseStatus as string,
      }));
      const current = () => ({
        attendees,
        ...(description === undefined ? {} : { description }),
        end: { dateTime: '2026-07-08T11:00:00Z' },
        etag,
        id: 'evt-invite',
        start: { dateTime: '2026-07-08T10:00:00Z', timeZone: 'UTC' },
        status: 'confirmed' as const,
        summary,
      });
      const layer = makeLayer({
        getEvent: () => Effect.sync(() => current()),
        patchEvent: ({ baseEtag, event, eventId }) =>
          Effect.suspend((): ReturnType<GoogleCalendarClientShape['patchEvent']> => {
            const keys = Object.keys(event).join(',');
            if (offline) {
              return Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
            }
            if (baseEtag !== undefined && baseEtag !== etag) {
              return Effect.fail(new ConflictError({ calendarId: 'cal-1', eventId }));
            }
            summary = typeof event.summary === 'string' ? event.summary : summary;
            description = typeof event.description === 'string' ? event.description : description;
            if (event.attendees) {
              attendees = event.attendees.map((guest) => ({
                email: guest.email,
                responseStatus: guest.responseStatus as string,
              }));
            }
            writes += 1;
            etag = `"w${writes}"`;
            sent.push(keys);
            return Effect.succeed(current());
          }),
      });
      return Effect.gen(function* () {
        yield* seed;
        const mutations = yield* EventMutations;
        const events = yield* EventRepo;
        const ops = yield* PendingOpRepo;
        const rename = (title: string) => mutations.updateEvent({ ...respond, changes: { title } });
        yield* rename('B');
        yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
        // Both back off.
        yield* mutations.processPendingOps();
        yield* rename('D');
        offline = false;
        yield* mutations.processPendingOps();
        const row = yield* events.getById('acc-1', 'cal-1', 'evt-invite');
        expect([row?.title, summary]).toEqual(['D', 'D']);
        // The user then edits the description of what they see.
        yield* mutations.updateEvent({ ...respond, changes: { description: 'Agenda' } });
        yield* ops.retryNow();
        yield* mutations.processPendingOps();
        yield* mutations.processPendingOps();
        const final = yield* events.getById('acc-1', 'cal-1', 'evt-invite');
        expect([final?.title, final?.description, final?.syncStatus]).toEqual([
          'D',
          'Agenda',
          'synced',
        ]);
        expect([summary, description]).toEqual(['D', 'Agenda']);
        expect(sent).toEqual(['summary', 'attendees', 'description']);
        expect(yield* ops.listAll()).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe('an answer given while an earlier one is out', () => {
  it.effect('the answer Google has, given again, is sent once the other has landed', () => {
    // Review (Opus): declined, then back to accepted while the decline was
    // out. Measured against Google's copy the second answer changed
    // nothing, and what went was the copy's answer once the decline had
    // landed: declined, on Google and on the row.
    const sent: Array<string | undefined> = [];
    let duringNext: Effect.Effect<unknown, unknown> | undefined;
    let attendees = invited.attendees!.map((attendee) => ({
      email: attendee.email,
      responseStatus: attendee.responseStatus as string,
    }));
    const own = () => attendees.find((guest) => guest.email === 'nik@example.com')?.responseStatus;
    const layer = makeLayer({
      patchEvent: ({ event }) =>
        Effect.gen(function* () {
          const during = duringNext;
          duringNext = undefined;
          if (during) {
            yield* Effect.orDie(during);
          }
          attendees = attendees.map((guest) => ({
            ...guest,
            responseStatus:
              event.attendees?.find((answer) => answer.email === guest.email)?.responseStatus ??
              guest.responseStatus,
          }));
          sent.push(own());
          return {
            attendees,
            end: { dateTime: '2026-07-08T11:00:00Z' },
            etag: `"a${sent.length}"`,
            id: 'evt-invite',
            start: { dateTime: '2026-07-08T10:00:00Z', timeZone: 'UTC' },
            status: 'confirmed' as const,
            summary: 'Planning',
          };
        }),
    });
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.respondToEvent({ ...respond, response: 'accepted' });
      yield* mutations.processPendingOps();
      yield* mutations.respondToEvent({ ...respond, response: 'declined' });
      duringNext = mutations.respondToEvent({ ...respond, response: 'accepted' });
      yield* mutations.processPendingOps();
      yield* mutations.processPendingOps();
      expect(sent).toEqual(['accepted', 'declined', 'accepted']);
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      const row = yield* (yield* EventRepo).getById('acc-1', 'cal-1', 'evt-invite');
      expect(
        row?.attendees?.find((guest) => guest.email === 'nik@example.com')?.responseStatus,
      ).toBe('accepted');
    }).pipe(Effect.provide(layer));
  });
});

describe('an answer to an occurrence changed here first', () => {
  it.effect(
    "Google has no exception of it: the answer does not make the edit Google's copy",
    () => {
      // Review (Codex, round 3): an occurrence renamed offline, which Google
      // has no exception for, then answered. The answer named the renamed
      // row as what Google has, so the rename differed from "Google's copy"
      // in nothing and its PATCH went out empty.
      const sent: Array<string> = [];
      const layer = makeLayer({
        patchEvent: ({ event }) => {
          sent.push(Object.keys(event).join(','));
          return Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
        },
      });
      return Effect.gen(function* () {
        yield* seed;
        const weekly = new EventRecord({
          ...invited,
          etag: '"series-1"',
          id: 'evt-weekly',
          recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
        });
        yield* (yield* EventRepo).upsertMany([weekly]);
        const mutations = yield* EventMutations;
        const second = weekly.startUtc + 7 * 24 * 60 * 60 * 1000;
        yield* mutations.updateRecurring({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          changes: { title: 'Planning (second)' },
          masterId: 'evt-weekly',
          originalStartUtc: second,
          scope: 'instance',
        });
        const [rename] = yield* (yield* PendingOpRepo).listAll();
        yield* mutations.respondToEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          eventId: rename!.eventId,
          response: 'accepted',
        });
        const queued = yield* (yield* PendingOpRepo).listAll();
        expect(
          queued.map((op) => `${op.kind} ${op.beforePayload === null ? 'no copy' : 'copy'}`),
        ).toEqual(['update no copy', 'rsvp no copy']);
        expect(queued[0]?.changed).toEqual(['title']);
        expect(queued[0]?.basePayload?.title).toBe('Planning');
        sent.length = 0;
        yield* (yield* PendingOpRepo).retryNow();
        yield* mutations.processPendingOps();
        expect(sent).toEqual(['summary', 'attendees']);
      }).pipe(Effect.provide(layer));
    },
  );
});
