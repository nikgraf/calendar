import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { Account, CalendarInfo, EventRecord, GeoLocation } from '@calendar/core';
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
  type GcalEvent,
  type GcalEventPatch,
  GoogleApiError,
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
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { makeHeldEvents } from './heldEvents.ts';
import { EventMutations } from './mutations.ts';

/**
 * How Google answers the series patch: offline keeps the op queued, a 412
 * parks it (Google's copy is `server`), a 400 drops it.
 */
interface Google {
  /** Answers the next PATCH in place of `patch`, once (a write that lands). */
  land?: (event: GcalEventPatch) => Effect.Effect<GcalEvent>;
  /** `reject-once`: the first PATCH is a 400, the ones after it are offline. */
  patch: 'conflict' | 'offline' | 'reject' | 'reject-once';
  /** What each PATCH named, answered or not: "<event id>: <fields>". */
  sent?: Array<string>;
  server?: GcalEvent;
}

const googleClient = (google: Google): GoogleCalendarClientShape => ({
  deleteEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
  getColors: () => Effect.succeed({ calendar: {} }),
  getEvent: () =>
    google.server
      ? Effect.succeed(google.server)
      : Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
  insertCalendar: () => Effect.die('not used'),
  insertEvent: () => Effect.fail(new ApiUnavailableError({ cause: 'offline' })),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  moveEvent: () => Effect.die('unexpected move'),
  patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
  patchEvent: ({ event, eventId }) => {
    google.sent?.push(`${eventId}: ${Object.keys(event).join(',')}`);
    if (google.land) {
      const land = google.land;
      delete google.land;
      return land(event);
    }
    if (google.patch === 'reject-once') {
      google.patch = 'offline';
      return Effect.fail(new GoogleApiError({ message: 'Invalid value', status: 400 }));
    }
    return google.patch === 'conflict'
      ? Effect.fail(new ConflictError({ calendarId: 'cal-1', eventId }))
      : google.patch === 'reject'
        ? Effect.fail(new GoogleApiError({ message: 'Invalid value', status: 400 }))
        : Effect.fail(new ApiUnavailableError({ cause: 'offline' }));
  },
  replaceEvent: () => Effect.die('not used'),
});

const stubTasksClient: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('tasks not used in this test'),
  insertTask: () => Effect.die('tasks not used in this test'),
  listTaskLists: () => Effect.die('tasks not used in this test'),
  listTasks: () => Effect.die('tasks not used in this test'),
  moveTask: () => Effect.die('tasks not used in this test'),
  patchTask: () => Effect.die('tasks not used in this test'),
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RULE = 'RRULE:FREQ=DAILY;COUNT=10';

const master = new EventRecord({
  accountId: 'acc-1',
  calendarId: 'cal-1',
  endUtc: Date.parse('2026-07-01T10:00:00Z'),
  etag: '"m-1"',
  id: 'master1',
  isAllDay: false,
  recurrence: [RULE],
  startTimeZone: 'UTC',
  startUtc: Date.parse('2026-07-01T09:00:00Z'),
  status: 'confirmed',
  syncedAt: 1,
  syncStatus: 'synced',
  title: 'Daily',
  updatedAt: 1,
});

const geo = new GeoLocation({ lat: 48.2, lng: 16.37, source: 'Stephansplatz 3, Wien' });

const exception = (day: number, fields: Partial<EventRecord>) => {
  const start = master.startUtc + day * DAY;
  return new EventRecord({
    ...master,
    endUtc: start + HOUR,
    etag: `"o-${day}"`,
    id: `master1_${new Date(start).toISOString().replaceAll(/[-:]|\.\d+/g, '')}`,
    originalStartUtc: start,
    recurrence: undefined,
    recurringEventId: 'master1',
    startUtc: start,
    ...fields,
  });
};

/** Its own title and a mapped location of its own. */
const moved = exception(3, { geo, location: geo.source, title: 'Daily (moved)' });
/** Still the series' text. */
const plain = exception(5, {});
const cancelled = exception(7, { status: 'cancelled', title: 'Old' });

const seed = Effect.gen(function* () {
  yield* (yield* AccountRepo).upsert(
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'acc-1@example.com',
      id: 'acc-1',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  );
  yield* (yield* CalendarRepo).upsertMany([
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
  yield* (yield* EventRepo).upsertMany([master, moved, plain, cancelled]);
});

const layer = (google: Google) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
    Layer.provideMerge(Layer.effectDiscard(seed)),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, googleClient(google))),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, stubTasksClient)),
  );

/**
 * Keeps the drain a mutation forks from running before the next call: it
 * would send the first of two changes a test queues before the second.
 */
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

const series = (changes: { location?: string; title?: string }) =>
  Effect.gen(function* () {
    yield* (yield* EventMutations).updateRecurring({
      accountId: 'acc-1',
      calendarId: 'cal-1',
      changes,
      masterId: 'master1',
      originalStartUtc: master.startUtc,
      scope: 'series',
    });
  });

const row = (id: string) =>
  Effect.gen(function* () {
    return yield* (yield* EventRepo).getById('acc-1', 'cal-1', id);
  });

const text = (id: string) =>
  Effect.map(row(id), (event) => ({ location: event?.location, title: event?.title }));

const masterOp = Effect.gen(function* () {
  const ops = yield* (yield* PendingOpRepo).listAll();
  return ops.filter((op) => op.eventId === 'master1');
});

describe('a series edit carries text onto the exceptions, undoably', () => {
  it.effect('a rename reaches every live exception and records its own text', () =>
    Effect.gen(function* () {
      yield* series({ title: 'Standup' });

      expect(yield* text(moved.id)).toEqual({ location: geo.source, title: 'Standup' });
      expect((yield* text(plain.id)).title).toBe('Standup');
      expect((yield* text(cancelled.id)).title).toBe('Old');
      const [op] = yield* masterOp;
      expect(op?.carriedText?.base).toEqual({ description: null, location: null, title: 'Daily' });
      expect(op?.carriedText?.overrides).toEqual([
        { etag: moved.etag, eventId: moved.id, title: 'Daily (moved)' },
        { etag: plain.etag, eventId: plain.id, title: 'Daily' },
      ]);
      // No op for the exceptions: Google updates them itself.
      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops.map((queued) => queued.eventId)).toEqual(['master1']);
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect("the editor's empty location is no change for a series without one", () =>
    Effect.gen(function* () {
      yield* series({ location: '', title: 'Standup' });

      const kept = yield* row(moved.id);
      expect(kept?.location).toBe(geo.source);
      expect(kept?.geo).toEqual(geo);
      expect((yield* masterOp)[0]?.carriedText?.overrides[0]).toEqual({
        etag: moved.etag,
        eventId: moved.id,
        title: 'Daily (moved)',
      });
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect("a carried location drops the exception's stale coordinates", () =>
    Effect.gen(function* () {
      yield* series({ location: 'Karlsplatz' });

      const carried = yield* row(moved.id);
      expect(carried?.location).toBe('Karlsplatz');
      expect(carried?.geo).toBeUndefined();
      expect((yield* text(plain.id)).location).toBe('Karlsplatz');
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect('an offline rename and its revert leave the exceptions as Google does', () =>
    Effect.gen(function* () {
      yield* series({ title: 'Standup' });
      yield* series({ title: 'Daily' });

      // Google gets one patch with the title it already has, so it keeps
      // the exception's own title.
      expect((yield* text(moved.id)).title).toBe('Daily (moved)');
      expect((yield* text(plain.id)).title).toBe('Daily');
      const ops = yield* masterOp;
      expect(ops).toHaveLength(1);
      expect(ops[0]?.payload?.title).toBe('Daily');
      expect(ops[0]?.carriedText).toBeUndefined();
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect('coalesced renames keep the text from before the first', () =>
    Effect.gen(function* () {
      yield* series({ title: 'Standup' });
      yield* series({ title: 'Sync' });

      expect((yield* text(moved.id)).title).toBe('Sync');
      const [op] = yield* masterOp;
      expect(op?.carriedText?.base.title).toBe('Daily');
      expect(op?.carriedText?.overrides[0]).toEqual({
        etag: moved.etag,
        eventId: moved.id,
        title: 'Daily (moved)',
      });

      yield* (yield* EventMutations).discardPendingOp(op!.id);
      expect((yield* text(moved.id)).title).toBe('Daily (moved)');
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect("discarding the edit puts the exceptions' own text back", () =>
    Effect.gen(function* () {
      yield* series({ location: 'Karlsplatz', title: 'Standup' });
      const [op] = yield* masterOp;
      yield* (yield* EventMutations).discardPendingOp(op!.id);

      expect(yield* text(moved.id)).toEqual({ location: geo.source, title: 'Daily (moved)' });
      expect(yield* text(plain.id)).toEqual({ location: undefined, title: 'Daily' });
      expect((yield* row('master1'))?.syncStatus).toBe('synced');
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect("a rejected edit puts the exceptions' own text back", () =>
    Effect.gen(function* () {
      yield* series({ title: 'Standup' });
      yield* (yield* EventMutations).processPendingOps();

      expect(yield* masterOp).toEqual([]);
      expect((yield* text(moved.id)).title).toBe('Daily (moved)');
      expect((yield* text(plain.id)).title).toBe('Daily');
    }).pipe(Effect.provide(layer({ patch: 'reject' }))),
  );

  it.effect("taking Google's version puts the exceptions' own text back", () => {
    const google: Google = {
      patch: 'conflict',
      server: {
        end: { dateTime: '2026-07-01T10:00:00Z', timeZone: 'UTC' },
        etag: '"m-2"',
        id: 'master1',
        recurrence: [RULE],
        start: { dateTime: '2026-07-01T09:00:00Z', timeZone: 'UTC' },
        status: 'confirmed',
        summary: 'Daily',
      },
    };
    return Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* series({ title: 'Standup' });
      yield* mutations.processPendingOps();
      const [op] = yield* masterOp;
      expect(op?.conflictAt).toBeDefined();
      // While the user decides, the exceptions show the edit, like the master.
      expect((yield* text(moved.id)).title).toBe('Standup');

      yield* mutations.resolveConflict({ choice: 'theirs', opId: op!.id });
      expect((yield* row('master1'))?.title).toBe('Daily');
      expect((yield* text(moved.id)).title).toBe('Daily (moved)');
      expect((yield* text(plain.id)).title).toBe('Daily');
      expect(yield* masterOp).toEqual([]);
    }).pipe(Effect.provide(layer(google)));
  });

  it.effect("taking Google's version keeps what a pull brought in meanwhile", () => {
    const google: Google = {
      patch: 'conflict',
      server: {
        end: { dateTime: '2026-07-01T10:00:00Z', timeZone: 'UTC' },
        etag: '"m-2"',
        id: 'master1',
        recurrence: [RULE],
        start: { dateTime: '2026-07-01T09:00:00Z', timeZone: 'UTC' },
        status: 'confirmed',
        // Another rename than ours: the same one would be our own edit
        // already on Google, and one of another field would simply hold
        // beside ours; neither needs a choice (applyOp park).
        summary: 'Daily sync',
      },
    };
    return Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* series({ title: 'Standup' });
      yield* mutations.processPendingOps();
      const [op] = yield* masterOp;
      // Another device renamed the series, Google carried that onto the
      // exception, and a pull brought that version in while ours waited.
      yield* (yield* EventRepo).upsertMany(
        [new EventRecord({ ...moved, etag: '"o-3-theirs"', title: 'Daily sync' })],
        { mode: 'pull' },
      );
      yield* mutations.resolveConflict({ choice: 'theirs', opId: op!.id });

      expect((yield* text(moved.id)).title).toBe('Daily sync');
      // Not pulled yet: its own text, until Google's copy arrives.
      expect((yield* text(plain.id)).title).toBe('Daily');
    }).pipe(Effect.provide(layer(google)));
  });

  it.effect("undoing a location carry brings the exception's coordinates back", () =>
    Effect.gen(function* () {
      yield* series({ location: 'Karlsplatz' });
      expect((yield* row(moved.id))?.geo).toBeUndefined();
      // The series had no location: reverting is no change on Google, which
      // keeps the exception's own place, coordinates included.
      yield* series({ location: '' });
      const reverted = yield* row(moved.id);
      expect(reverted?.location).toBe(geo.source);
      expect(reverted?.geo).toEqual(geo);

      yield* series({ location: 'Karlsplatz' });
      const [op] = yield* masterOp;
      yield* (yield* EventMutations).discardPendingOp(op!.id);
      const restored = yield* row(moved.id);
      expect(restored?.location).toBe(geo.source);
      expect(restored?.geo).toEqual(geo);
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect("Google's own rename, pulled while an edit waits, is not carried again", () =>
    Effect.gen(function* () {
      const events = yield* EventRepo;
      const queue = yield* PendingOpRepo;
      yield* series({ location: 'Room 1' });
      // Another device renamed the series, and named this exception itself
      // after that; a pull brings both while the location edit waits.
      const theirs = [
        new EventRecord({ ...master, etag: '"m-2"', title: 'Daily sync' }),
        new EventRecord({ ...plain, etag: '"o-5-theirs"', title: 'Retro' }),
      ];
      const held = makeHeldEvents({ eventRepo: events, pendingOpRepo: queue });
      yield* events.upsertMany(yield* held.receive('acc-1', 'cal-1', theirs), { mode: 'pull' });
      expect((yield* row('master1'))?.title).toBe('Daily sync');

      // The next edit changes no title on Google: the exception keeps its own.
      yield* (yield* EventMutations).updateRecurring({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { description: 'Agenda in the doc' },
        masterId: 'master1',
        originalStartUtc: master.startUtc,
        scope: 'series',
      });
      expect((yield* text(plain.id)).title).toBe('Retro');
      const [op] = yield* masterOp;
      expect(op?.carriedText?.base.title).toBe('Daily sync');
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect('an exception edited after the carry keeps its newer text', () =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* series({ title: 'Standup' });
      yield* mutations.updateRecurring({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Custom' },
        masterId: 'master1',
        originalStartUtc: moved.originalStartUtc!,
        scope: 'instance',
      });
      // The series' next rename takes the first one's place in the queue,
      // ahead of the exception's edit: Google copies the new title onto
      // every exception, so the edited one takes it too, in its row and in
      // what its own change sends.
      const own = Effect.map(
        (yield* PendingOpRepo).listAll(),
        (ops) => ops.find((op) => op.eventId === moved.id)?.payload?.title,
      );
      yield* series({ title: 'Weekly' });
      expect((yield* masterOp).map((op) => op.payload?.title)).toEqual(['Weekly']);
      expect((yield* text(moved.id)).title).toBe('Weekly');
      expect(yield* own).toBe('Weekly');
      expect((yield* text(plain.id)).title).toBe('Weekly');

      yield* series({ title: 'Sync' });
      expect((yield* masterOp).map((op) => op.payload?.title)).toEqual(['Sync']);
      expect((yield* text(moved.id)).title).toBe('Sync');
      // Discarded, the exceptions show what they did before the renames:
      // the edited one its own title, which its change sends again.
      yield* mutations.discardPendingOp((yield* masterOp).at(-1)!.id);
      expect((yield* text('master1')).title).toBe('Daily');
      expect((yield* text(moved.id)).title).toBe('Custom');
      expect(yield* own).toBe('Custom');
      expect((yield* text(plain.id)).title).toBe('Daily');
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect("a rename set back gives an exception's queued change its own title back", () => {
    // The series' rename had won over the exception's own title, in its
    // row and in what its queued change sends. Set back to the title
    // Google has, the series no longer changes it there, so nothing is
    // copied: the row showed the exception's own again, while its change
    // still sent the rename that was gone.
    const google: Google = { patch: 'offline', sent: [] };
    return Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* series({ title: 'Standup' });
      yield* mutations.updateRecurring({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Custom' },
        masterId: 'master1',
        originalStartUtc: moved.originalStartUtc!,
        scope: 'instance',
      });
      yield* series({ title: 'Weekly' });
      const own = Effect.map(
        (yield* PendingOpRepo).listAll(),
        (ops) => ops.find((op) => op.eventId === moved.id)?.payload?.title,
      );
      expect([yield* own, (yield* text(moved.id)).title]).toEqual(['Weekly', 'Weekly']);
      yield* series({ title: 'Daily' });
      expect([yield* own, (yield* text(moved.id)).title]).toEqual(['Custom', 'Custom']);
    }).pipe(Effect.provide(layer(google)));
  });

  it.effect(
    "an exception named like its series by hand keeps that name when the series' rename goes",
    () => {
      // Its title equal to the series' read as the series' carry, and the
      // discard of the series' rename put the exception's old title into
      // its row and its queued change: the user's own rename was lost.
      const google: Google = { patch: 'offline', sent: [] };
      return Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const rename = (title: string) =>
          mutations.updateRecurring({
            accountId: 'acc-1',
            calendarId: 'cal-1',
            changes: { title },
            masterId: 'master1',
            originalStartUtc: moved.originalStartUtc!,
            scope: 'instance',
          });
        yield* series({ title: 'Standup' });
        yield* rename('Custom');
        yield* rename('Standup');
        const [seriesOp] = yield* masterOp;
        yield* mutations.discardPendingOp(seriesOp!.id);
        const own = (yield* (yield* PendingOpRepo).listAll()).find((op) => op.eventId === moved.id);
        expect([own?.payload?.title, (yield* text(moved.id)).title]).toEqual([
          'Standup',
          'Standup',
        ]);
        // The exception the series' rename alone had reached has its own back.
        expect((yield* text(plain.id)).title).toBe('Daily');
      }).pipe(Effect.provide(layer(google)));
    },
  );

  it.effect('an exception edited under a queued rename keeps only its own change', () => {
    // Its change was measured against Google's copy of it, which has its
    // own title: the carried one counted as the exception's, and went to
    // Google as that after the rename was discarded.
    const google: Google = { patch: 'offline', sent: [] };
    return Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* series({ title: 'Standup' });
      yield* mutations.updateRecurring({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { description: 'Notes' },
        masterId: 'master1',
        originalStartUtc: plain.originalStartUtc!,
        scope: 'instance',
      });
      const own = Effect.map((yield* PendingOpRepo).listAll(), (ops) => {
        const op = ops.find((one) => one.eventId === plain.id);
        return [op?.changed?.join(','), op?.payload?.title, op?.beforePayload?.title];
      });
      // Laid over Google's copy with the rename's title carried onto it.
      expect(yield* own).toEqual(['description', 'Standup', 'Daily']);

      yield* mutations.discardPendingOp((yield* masterOp)[0]!.id);
      expect(yield* own).toEqual(['description', 'Daily', 'Daily']);
      expect((yield* text(plain.id)).title).toBe('Daily');
      google.sent = [];
      yield* mutations.processPendingOps();
      expect(google.sent).toEqual([`${plain.id}: description`]);
    }).pipe(Effect.provide(layer(google)));
  });

  it.effect("under two queued edits of its series, an exception's copy holds its own text", () =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      const instance = (id: EventRecord, changes: { description?: string; title?: string }) =>
        mutations.updateRecurring({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          changes,
          masterId: 'master1',
          originalStartUtc: id.originalStartUtc!,
          scope: 'instance',
        });
      // A place for all, one exception's own title, then a title for all:
      // one change of the series, ahead of the exception's.
      yield* series({ location: 'Room 1' });
      yield* instance(moved, { title: 'Custom' });
      yield* series({ title: 'Standup' });
      expect((yield* masterOp).map((op) => op.changed?.join(','))).toEqual(['location,title,geo']);
      expect(yield* text(plain.id)).toEqual({ location: 'Room 1', title: 'Standup' });

      yield* instance(plain, { description: 'Notes' });
      const op = (yield* (yield* PendingOpRepo).listAll()).find((one) => one.eventId === plain.id);
      // Google has neither edit yet: its copy of the exception is as it was.
      expect([op?.beforePayload?.title, op?.beforePayload?.location]).toEqual(['Daily', undefined]);
      expect(op?.changed).toEqual(['description']);
      expect([op?.payload?.title, op?.payload?.location]).toEqual(['Standup', 'Room 1']);
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );

  it.effect('a change Google rejects takes the ones made on top of it along', () =>
    // Review (Codex, round 3): "does not repeat", then new times for the
    // single event that left, then two changes in the queue. Google turned
    // the first down for good, the second stayed queued, had the rule back
    // under it and would have moved every occurrence. They are one change
    // now, and go together.
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      const at = { accountId: 'acc-1', calendarId: 'cal-1' };
      yield* mutations.updateRecurring({
        ...at,
        changes: { recurrence: null },
        masterId: 'master1',
        originalStartUtc: master.startUtc,
        scope: 'series',
      });
      yield* mutations.updateEvent({
        ...at,
        changes: { endUtc: master.endUtc + HOUR, startUtc: master.startUtc + HOUR },
        eventId: 'master1',
      });
      expect((yield* masterOp).length).toBe(1);
      yield* mutations.processPendingOps();
      expect(yield* masterOp).toEqual([]);
      const back = yield* row('master1');
      expect([back?.recurrence, back?.startUtc, back?.syncStatus]).toEqual([
        [RULE],
        master.startUtc,
        'synced',
      ]);
    }).pipe(noYield, Effect.provide(layer({ patch: 'reject-once' }))),
  );

  it.effect('a new rule made while the first rule is on its way is still sent', () => {
    // Review (Opus, round 5): a rule for all, one occurrence's own place, a
    // place for all, and, while the rule's PATCH was out, another rule.
    // (With the place queued as a change of its own, the new rule was
    // written into the update on its way and left out of the new one as
    // nothing new; the PATCH landed with the first rule, and the last one
    // was gone for good.)
    const second = 'RRULE:FREQ=DAILY;COUNT=6';
    const google: Google = { patch: 'offline' };
    return Effect.gen(function* () {
      const mutations = yield* EventMutations;
      const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'master1' };
      const forAll = (changes: { location?: string; recurrence?: Array<string> }) =>
        mutations.updateRecurring({
          ...at,
          changes,
          originalStartUtc: master.startUtc,
          scope: 'series',
        });
      yield* forAll({ recurrence: ['RRULE:FREQ=DAILY;INTERVAL=2;COUNT=10'] });
      yield* mutations.updateRecurring({
        ...at,
        changes: { location: 'Room 2' },
        originalStartUtc: master.startUtc + 2 * DAY,
        scope: 'instance',
      });
      yield* forAll({ location: 'Room 3' });
      expect((yield* masterOp).length).toBe(1);
      // The first rule lands; the second is made while it is out.
      google.land = (event) =>
        Effect.as(Effect.orDie(forAll({ recurrence: [second] })), {
          end: { dateTime: '2026-07-01T10:00:00Z', timeZone: 'UTC' },
          etag: '"m-2"',
          id: 'master1',
          recurrence: event.recurrence ?? [RULE],
          start: { dateTime: '2026-07-01T09:00:00Z', timeZone: 'UTC' },
          status: 'confirmed',
          summary: 'Daily',
        });
      yield* (yield* PendingOpRepo).retryNow();
      yield* mutations.processPendingOps();
      // Google has the first rule; what still waits holds the second over it.
      const waiting = yield* masterOp;
      expect(waiting.map((op) => op.basePayload?.recurrence)).toEqual([
        ['RRULE:FREQ=DAILY;INTERVAL=2;COUNT=10'],
      ]);
      expect(waiting.map((op) => [op.payload?.recurrence, op.payload?.location])).toEqual([
        [[second], 'Room 3'],
      ]);
      expect((yield* row('master1'))?.recurrence).toEqual([second]);
    }).pipe(Effect.provide(layer(google)));
  });

  it.effect("a cut that takes a series edit's place still sends its reminders", () => {
    // Review (Opus, round 8): reminders ride on a flag of the op that set
    // them. The cut took the edit's place without it, sent the new end of
    // the series alone, and the reminders reverted when it landed.
    const google: Google = { patch: 'offline', sent: [] };
    return Effect.gen(function* () {
      const mutations = yield* EventMutations;
      const at = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'master1' };
      yield* mutations.updateRecurring({
        ...at,
        changes: { reminders: { overrides: [{ method: 'popup', minutes: 5 }], useDefault: false } },
        originalStartUtc: master.startUtc,
        scope: 'series',
      });
      yield* mutations.deleteRecurring({
        ...at,
        originalStartUtc: master.startUtc + 8 * DAY,
        scope: 'following',
      });
      google.sent = [];
      yield* (yield* PendingOpRepo).retryNow();
      yield* mutations.processPendingOps();
      expect(google.sent[0]).toBe('master1: recurrence,reminders');
    }).pipe(Effect.provide(layer(google)));
  });

  it.effect('splitting the series keeps the carry undoable', () =>
    Effect.gen(function* () {
      const mutations = yield* EventMutations;
      yield* series({ title: 'Standup' });
      yield* mutations.updateRecurring({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Tail' },
        masterId: 'master1',
        originalStartUtc: master.startUtc + 8 * DAY,
        scope: 'following',
      });
      const [truncation] = yield* masterOp;
      expect(truncation?.payload?.recurrence?.[0]).toContain('UNTIL=');
      expect(truncation?.carriedText?.base.title).toBe('Daily');

      yield* mutations.discardPendingOp(truncation!.id);
      expect((yield* text(moved.id)).title).toBe('Daily (moved)');
    }).pipe(Effect.provide(layer({ patch: 'offline' }))),
  );
});
