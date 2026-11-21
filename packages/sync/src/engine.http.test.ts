import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import {
  Account,
  assembleWindow,
  eventsScope,
  GEO_PROPERTY_KEYS,
  GeoLocation,
  googleInstanceId,
} from '@calendar/core';
import {
  AccountRepo,
  BirthdayRepo,
  CalendarRepo,
  EventRepo,
  PendingOpRepo,
  reposLayer,
  runMigrations,
  SyncStateRepo,
  TaskRepo,
} from '@calendar/db';
import {
  GOOGLE_BIRTHDAYS_CALENDAR_ID,
  GoogleCalendarClient,
  GooglePeopleClient,
  GoogleTasksClient,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer, Scheduler } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';
import { FakeGoogle } from './testing/fakeGoogle.ts';

/**
 * The engine, the mutations and the real Google clients against the
 * in-process fake API (testing/fakeGoogle.ts). engine.test.ts scripts the
 * client shapes; these tests exercise the HTTP layer, the request core's
 * status mapping and the sync protocol end to end.
 */

const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

const engineLayer = (google: FakeGoogle) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(GoogleCalendarClient.layer),
    Layer.provideMerge(GoogleTasksClient.layer),
    Layer.provideMerge(GooglePeopleClient.layer),
    Layer.provideMerge(google.layer),
  );

const seedAccount = (tasksEnabled: boolean, contactsEnabled = false) =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo;
    yield* accounts.upsert(
      new Account({
        contactsEnabled,
        createdAt: 1,
        email: 'nik@example.com',
        id: 'acc-1',
        provider: 'google',
        status: 'ok',
        tasksEnabled,
      }),
    );
  });

const timed = (id: string, hour: number, summary = `Event ${id}`) => ({
  end: { dateTime: `2026-07-02T${String(hour + 1).padStart(2, '0')}:00:00Z` },
  id,
  start: { dateTime: `2026-07-02T${String(hour).padStart(2, '0')}:00:00Z` },
  status: 'confirmed',
  summary,
});

const newFake = () =>
  new FakeGoogle({
    calendars: [{ accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' }],
    taskLists: [{ id: 'list-1', title: 'My Tasks' }],
  });

const eventTitles = Effect.gen(function* () {
  const events = yield* EventRepo;
  const window = yield* events.getWindow(0, Number.MAX_SAFE_INTEGER);
  return window.singles.map((event) => `${event.id}:${event.title}`).sort();
});

/** 200, or the status Google refused a write with. */
const writeStatus = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E, GoogleCalendarClient>,
): Effect.Effect<number, E, GoogleCalendarClient> =>
  effect.pipe(
    Effect.map(() => 200),
    Effect.catchIf(
      (error): error is E & { readonly status: number } => error._tag === 'GoogleApiError',
      (error) => Effect.succeed(error.status),
    ),
  );

/** Synced event a, edit 1 landed, then Google moved on and edit 2 met a 412. */
const parkedEdit = (google: FakeGoogle) =>
  Effect.gen(function* () {
    yield* seedAccount(false);
    const engine = yield* SyncEngine;
    const mutations = yield* EventMutations;
    yield* engine.syncAll();

    // Edit 1 lands: PATCH with the etag we hold.
    yield* mutations.updateEvent({
      accountId: 'acc-1',
      calendarId: 'cal-1',
      changes: { title: 'Local 1' },
      eventId: 'a',
    });
    yield* mutations.processPendingOps();
    expect(google.eventOf('cal-1', 'a')?.summary).toBe('Local 1');
    expect(yield* (yield* PendingOpRepo).listAll()).toHaveLength(0);

    // The server moves on behind our back; our next edit carries the
    // old etag → 412 → parked with Google's version for the user.
    google.putEvent('cal-1', timed('a', 9, 'Server 2'));
    yield* mutations.updateEvent({
      accountId: 'acc-1',
      calendarId: 'cal-1',
      changes: { title: 'Local 2' },
      eventId: 'a',
    });
    yield* mutations.processPendingOps();
    expect(google.eventOf('cal-1', 'a')?.summary).toBe('Server 2');
    const [op] = yield* (yield* PendingOpRepo).listAll();
    expect(op?.conflictAt).toBeDefined();
    expect(op?.beforePayload?.title).toBe('Server 2');

    // A pull while parked leaves the user's version alone.
    yield* TestClock.adjust('1 minute');
    yield* engine.syncAll();
    expect(yield* eventTitles).toEqual(['a:Local 2']);
    return { engine, mutations, opId: op!.id };
  });

describe('SyncEngine over HTTP (fake Google)', () => {
  it.effect('a same-account move lands through events.move and the next pass agrees', () => {
    const google = new FakeGoogle({
      calendars: [
        { accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' },
        { accessRole: 'owner', id: 'cal-2', summary: 'Work' },
      ],
    });
    google.putEvent('cal-1', {
      ...timed('mv', 9, 'Planning'),
      organizer: { email: 'nik@example.com', self: true },
    });
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      yield* (yield* EventMutations).moveEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: 'mv',
        target: { accountId: 'acc-1', calendarId: 'cal-2' },
      });
      yield* engine.syncAll();
      expect(google.eventOf('cal-2', 'mv')?.summary).toBe('Planning');
      expect(google.eventOf('cal-1', 'mv')?.status).toBe('cancelled');
      const events = yield* EventRepo;
      expect(yield* events.getById('acc-1', 'cal-1', 'mv')).toBeNull();
      expect((yield* events.getById('acc-1', 'cal-2', 'mv'))?.syncStatus).toBe('synced');
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
    }).pipe(Effect.provide(engineLayer(google)));
  });

  it.effect(
    'an edit saved just before a same-account move lands after it, in the new calendar',
    () => {
      const google = new FakeGoogle({
        calendars: [
          { accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' },
          { accessRole: 'owner', id: 'cal-2', summary: 'Work' },
        ],
      });
      google.putEvent('cal-1', {
        ...timed('mv', 9, 'Planning'),
        organizer: { email: 'nik@example.com', self: true },
      });
      // The moved copy's etag differs from the one cal-1 handed out, as
      // on Google; something already in cal-2 moves its version count too.
      google.putEvent('cal-2', timed('other', 14, 'Other'));
      return Effect.gen(function* () {
        yield* seedAccount(false);
        const engine = yield* SyncEngine;
        yield* engine.syncAll();
        const mutations = yield* EventMutations;
        // The editor's Save: the edit first, then the move. events.move bumps
        // the etag, so the re-queued edit must not carry its pre-move If-Match.
        yield* mutations.updateEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          changes: { title: 'Planned' },
          eventId: 'mv',
        });
        yield* mutations.moveEvent({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          eventId: 'mv',
          target: { accountId: 'acc-1', calendarId: 'cal-2' },
        });
        yield* engine.syncAll();
        expect(google.eventOf('cal-2', 'mv')?.summary).toBe('Planned');
        const events = yield* EventRepo;
        expect((yield* events.getById('acc-1', 'cal-2', 'mv'))?.title).toBe('Planned');
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }).pipe(noYield, Effect.provide(engineLayer(google)));
    },
  );

  it.effect('birthdays come from People, and the Birthdays calendar is never synced', () => {
    const google = new FakeGoogle({
      calendars: [
        { accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' },
        { accessRole: 'reader', id: GOOGLE_BIRTHDAYS_CALENDAR_ID, summary: 'Birthdays' },
      ],
      people: [
        {
          birthdays: [{ date: { day: 4, month: 3, year: 1994 } }],
          names: [{ displayName: 'Alice Example' }],
          resourceName: 'people/c1',
        },
      ],
    });
    return Effect.gen(function* () {
      yield* seedAccount(false, true);
      yield* (yield* SyncEngine).syncAll();
      const calendars = yield* (yield* CalendarRepo).list('acc-1');
      expect(calendars.map((calendar) => calendar.id)).toEqual(['cal-1']);
      expect(
        google.requests.some((request) => request.url.includes('addressbook%23contacts')),
      ).toBe(false);
      const birthdays = yield* (yield* BirthdayRepo).listAll();
      expect(birthdays.map((row) => [row.displayName, row.month, row.day, row.year])).toEqual([
        ['Alice Example', 3, 4, 1994],
      ]);
      const connections = google.requests.find((request) => request.url.includes('/connections'));
      const others = google.requests.find((request) => request.url.includes('/otherContacts'));
      expect(new URL(connections!.url).searchParams.get('personFields')).toContain('birthdays');
      expect(new URL(others!.url).searchParams.get('readMask')).not.toContain('birthdays');
    }).pipe(Effect.provide(engineLayer(google)));
  });

  it.effect('a full pass stores the calendar and its events; the next pass is incremental', () => {
    const google = newFake();
    google.putEvent('cal-1', timed('a', 9));
    google.putEvent('cal-1', timed('b', 11));
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      expect(yield* eventTitles).toEqual(['a:Event a', 'b:Event b']);

      // Server-side edit + delete: the second pass sends the sync token
      // and applies only the two changes (the tombstone removes b).
      google.putEvent('cal-1', timed('a', 9, 'Renamed a'));
      google.cancelEvent('cal-1', 'b');
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect(yield* eventTitles).toEqual(['a:Renamed a']);
      const listCalls = google.requests.filter(
        (call) => call.method === 'GET' && call.url.includes('/calendars/cal-1/events'),
      );
      expect(listCalls[0]!.url).not.toContain('syncToken=');
      // All history: the full list carries no window at all.
      expect(listCalls[0]!.url).not.toContain('timeMin=');
      expect(listCalls[1]!.url).toContain('syncToken=cal-1%3A2');
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('location coordinates round-trip through private extended properties', () => {
    const google = newFake();
    const location = 'Naschmarkt, Vienna, Austria';
    const geo = new GeoLocation({
      lat: 48.1977,
      lng: 16.3616,
      name: 'Naschmarkt',
      source: location,
    });
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      const mutations = yield* EventMutations;
      yield* engine.syncAll();

      // Picked in the editor: the insert carries the coordinates.
      const created = yield* mutations.createEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        endUtc: Date.parse('2026-07-02T13:00:00Z'),
        geo,
        isAllDay: false,
        location,
        startTimeZone: 'Europe/Vienna',
        startUtc: Date.parse('2026-07-02T12:00:00Z'),
        title: 'Lunch',
      });
      yield* mutations.processPendingOps();
      expect(google.eventOf('cal-1', created.id)?.extendedProperties?.private).toEqual({
        [GEO_PROPERTY_KEYS.coordinates]: '48.1977,16.3616',
        [GEO_PROPERTY_KEYS.name]: 'Naschmarkt',
        [GEO_PROPERTY_KEYS.source]: location,
      });

      // Another device reads them back.
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      const events = yield* EventRepo;
      expect((yield* events.getById('acc-1', 'cal-1', created.id))?.geo).toEqual(geo);

      // An unrelated edit leaves the keys alone (and never sends deletes).
      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Lunch (late)' },
        eventId: created.id,
      });
      yield* mutations.processPendingOps();
      expect(google.eventOf('cal-1', created.id)?.extendedProperties?.private).toMatchObject({
        [GEO_PROPERTY_KEYS.source]: location,
      });

      // Moving the event here drops the coordinates and deletes the keys.
      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { location: 'Office' },
        eventId: created.id,
      });
      yield* mutations.processPendingOps();
      expect(google.eventOf('cal-1', created.id)?.extendedProperties).toBeUndefined();
      expect(google.eventOf('cal-1', created.id)?.location).toBe('Office');

      // Another client's edit makes mirrored keys stale: they are ignored
      // on pull (and overwritten by the next pick, not deleted).
      const server = google.eventOf('cal-1', created.id)!;
      google.putEvent('cal-1', {
        ...server,
        extendedProperties: {
          private: {
            [GEO_PROPERTY_KEYS.coordinates]: '48.1977,16.3616',
            [GEO_PROPERTY_KEYS.source]: location,
          },
        },
        location: 'Elsewhere',
      });
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect((yield* events.getById('acc-1', 'cal-1', created.id))?.geo).toBeUndefined();
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('the full list has no time floor: years-old events arrive, in pages', () => {
    const google = new FakeGoogle({
      calendars: [{ accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' }],
      pageSize: 2,
    });
    google.putEvent('cal-1', {
      end: { dateTime: '2019-03-04T10:00:00Z' },
      id: 'ancient',
      start: { dateTime: '2019-03-04T09:00:00Z' },
      status: 'confirmed',
      summary: 'Offsite 2019',
    });
    for (const [id, hour] of [
      ['a', 9],
      ['b', 11],
      ['c', 13],
      ['d', 15],
    ] as const) {
      google.putEvent('cal-1', timed(id, hour));
    }
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      expect(yield* eventTitles).toEqual([
        'a:Event a',
        'ancient:Offsite 2019',
        'b:Event b',
        'c:Event c',
        'd:Event d',
      ]);
      const listCalls = google.requests.filter(
        (call) => call.method === 'GET' && call.url.includes('/calendars/cal-1/events'),
      );
      // Five events at two per page: three requests, the token from the last.
      expect(listCalls).toHaveLength(3);
      expect(listCalls.every((call) => !call.url.includes('timeMin='))).toBe(true);
      const state = yield* (yield* SyncStateRepo).get('acc-1', eventsScope('cal-1'));
      expect(state?.syncToken).toBe('cal-1:5');
      expect(state?.status).toBe('idle');
      expect(yield* (yield* SyncStateRepo).summarizeEvents()).toEqual([
        { accountId: 'acc-1', importing: 0 },
      ]);
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('a calendar that arrives with a stale events scope re-lists its history', () => {
    const google = newFake();
    google.putEvent('cal-1', timed('a', 9));
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      // A crash between the deletes of an old removal: calendar row and
      // events gone, the events token left behind.
      yield* (yield* EventRepo).deleteByCalendar('acc-1', 'cal-1');
      yield* (yield* CalendarRepo).removeByIds('acc-1', ['cal-1']);
      expect((yield* (yield* SyncStateRepo).get('acc-1', eventsScope('cal-1')))?.syncToken).toBe(
        'cal-1:1',
      );
      // Upstream still has the calendar: it comes back as new to us.
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect(yield* eventTitles).toEqual(['a:Event a']);
      const listCalls = google.requests.filter(
        (call) => call.method === 'GET' && call.url.includes('/calendars/cal-1/events'),
      );
      expect(
        listCalls.map((call) => (call.url.includes('syncToken=') ? 'incremental' : 'full')),
      ).toEqual(['full', 'full']);
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('a calendar removed upstream takes its events with it', () => {
    const google = newFake();
    google.putEvent('cal-1', timed('a', 9));
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      expect(yield* (yield* EventRepo).countByAccount()).toEqual([
        { accountId: 'acc-1', eventCount: 1 },
      ]);
      google.removeCalendar('cal-1');
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect(yield* (yield* EventRepo).countByAccount()).toEqual([]);
      // Its sync state goes too: a calendar that comes back lists its
      // history again instead of resuming a token onto an empty table.
      expect(yield* (yield* SyncStateRepo).get('acc-1', eventsScope('cal-1'))).toBeNull();
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('an expired sync token (410) forces a full resync that drops vanished rows', () => {
    const google = newFake();
    google.putEvent('cal-1', timed('a', 9));
    google.putEvent('cal-1', timed('b', 11));
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      yield* engine.syncAll();

      // While our token was expiring, b was deleted and its tombstone
      // aged out: a full pass must notice b is gone without ever seeing
      // a tombstone for it.
      google.expireSyncTokens('cal-1');
      google.cancelEvent('cal-1', 'b');
      // passStartedAt must move on for deleteStale to see b as untouched.
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect(yield* eventTitles).toEqual(['a:Event a']);
      const statuses = google.requests
        .filter((call) => call.method === 'GET' && call.url.includes('/events'))
        .map((call) => (call.url.includes('syncToken=') ? 'incremental' : 'full'));
      expect(statuses).toEqual(['full', 'incremental', 'full']);
      // The resync lists the whole history again, not a window.
      expect(google.requests.every((call) => !call.url.includes('timeMin='))).toBe(true);
      // The next pass resumes from the token the resync handed out.
      const state = yield* (yield* SyncStateRepo).get('acc-1', eventsScope('cal-1'));
      expect(state?.syncToken).toBe('cal-1:3');
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect("a stale etag is a 412 that parks the edit; take theirs restores Google's copy", () => {
    const google = newFake();
    google.putEvent('cal-1', timed('a', 9));
    return Effect.gen(function* () {
      const { engine, mutations, opId } = yield* parkedEdit(google);
      yield* mutations.resolveConflict({ choice: 'theirs', opId });
      expect(yield* eventTitles).toEqual(['a:Server 2']);
      expect(yield* (yield* PendingOpRepo).listAll()).toHaveLength(0);
      // Back in sync: the next pass changes nothing.
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect(yield* eventTitles).toEqual(['a:Server 2']);
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('keep mine re-sends a parked edit without If-Match', () => {
    const google = newFake();
    google.putEvent('cal-1', timed('a', 9));
    return Effect.gen(function* () {
      const { engine, mutations, opId } = yield* parkedEdit(google);
      yield* mutations.resolveConflict({ choice: 'mine', opId });
      yield* mutations.processPendingOps();
      expect(google.eventOf('cal-1', 'a')?.summary).toBe('Local 2');
      expect(yield* (yield* PendingOpRepo).listAll()).toHaveLength(0);
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect(yield* eventTitles).toEqual(['a:Local 2']);
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect(
    'a parked delete: the event stays deleted through a pull, delete anyway removes it',
    () => {
      const google = newFake();
      google.putEvent('cal-1', timed('a', 9));
      return Effect.gen(function* () {
        yield* seedAccount(false);
        const engine = yield* SyncEngine;
        const mutations = yield* EventMutations;
        yield* engine.syncAll();

        google.putEvent('cal-1', timed('a', 9, 'Server 2'));
        yield* mutations.deleteEvent({ accountId: 'acc-1', calendarId: 'cal-1', eventId: 'a' });
        yield* mutations.processPendingOps();
        const [op] = yield* (yield* PendingOpRepo).listAll();
        expect(op?.kind).toBe('delete');
        expect(op?.conflictAt).toBeDefined();
        expect(op?.payload?.title).toBe('Event a');

        // The pull's copy goes beside the row the delete took: nothing comes back.
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        expect(yield* eventTitles).toEqual([]);

        yield* mutations.resolveConflict({ choice: 'mine', opId: op!.id });
        expect(yield* eventTitles).toEqual([]);
        yield* mutations.processPendingOps();
        expect(google.eventOf('cal-1', 'a')?.status).toBe('cancelled');
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        expect(yield* eventTitles).toEqual([]);
      }).pipe(noYield, Effect.provide(engineLayer(google)));
    },
  );

  it.effect('a timed event turns all-day and back: the unused time form is nulled', () => {
    // Google merges start/end fields on PATCH: sending only `date` kept the
    // old `dateTime`, and Google answered 400 "Invalid start time" (seen
    // on the first live iOS run) — the op was dropped, the row stayed
    // all-day here and timed on Google.
    const google = newFake();
    google.putEvent('cal-1', timed('a', 9));
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      const mutations = yield* EventMutations;
      yield* engine.syncAll();

      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { endDate: '2026-07-03', isAllDay: true, startDate: '2026-07-02' },
        eventId: 'a',
      });
      yield* mutations.processPendingOps();
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      expect(google.eventOf('cal-1', 'a')?.start).toEqual({ date: '2026-07-02' });
      expect(google.eventOf('cal-1', 'a')?.end).toEqual({ date: '2026-07-03' });

      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: {
          endUtc: Date.parse('2026-07-02T11:00:00Z'),
          isAllDay: false,
          startUtc: Date.parse('2026-07-02T10:00:00Z'),
        },
        eventId: 'a',
      });
      yield* mutations.processPendingOps();
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      expect(google.eventOf('cal-1', 'a')?.start?.date).toBeUndefined();
      expect(google.eventOf('cal-1', 'a')?.start?.dateTime).toBe('2026-07-02T10:00:00Z');
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('a re-posted event id is a 409, also after the event was deleted', () => {
    const google = newFake();
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      const insert = client.insertEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        event: { ...timed('slnvmrabc', 9), summary: 'Copy' },
      });
      yield* insert;
      expect(yield* writeStatus(insert)).toBe(409);
      yield* client.deleteEvent({ accountId: 'acc-1', calendarId: 'cal-1', eventId: 'slnvmrabc' });
      // The id stays reserved by the tombstone.
      expect(yield* writeStatus(insert)).toBe(409);
    }).pipe(Effect.provide(engineLayer(google)));
  });

  it.effect('a full replace clears what it leaves out and brings a deleted event back', () => {
    const google = newFake();
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      const target = { accountId: 'acc-1', calendarId: 'cal-1', eventId: 'slnvmrdef' };
      const { status: _status, ...body } = { ...timed('slnvmrdef', 9), summary: 'Copy' };
      yield* client.insertEvent({
        ...target,
        event: {
          ...body,
          description: 'Dial-in 1234',
          extendedProperties: { private: { keep: 'no' } },
          location: 'Room 4',
        },
      });
      yield* client.patchEvent({ ...target, event: { summary: 'Patched' } });
      expect(google.eventOf('cal-1', 'slnvmrdef')?.location).toBe('Room 4');

      const replaced = yield* client.replaceEvent({ ...target, event: body });
      expect(replaced.summary).toBe('Copy');
      const stored = google.eventOf('cal-1', 'slnvmrdef');
      expect(stored?.location).toBeUndefined();
      expect(stored?.description).toBeUndefined();
      expect(stored?.extendedProperties).toBeUndefined();

      // If-Match guards a replace like any other write.
      const stale = yield* client
        .replaceEvent({ ...target, baseEtag: '"stale"', event: body })
        .pipe(Effect.flip);
      expect(stale._tag).toBe('ConflictError');

      yield* client.deleteEvent(target);
      // A deleted event refuses a plain replace and accepts a confirming one.
      const gone = yield* client.replaceEvent({ ...target, event: body }).pipe(Effect.flip);
      expect(gone._tag).toBe('NotFoundError');
      yield* client.replaceEvent({ ...target, event: { ...body, status: 'confirmed' } });
      expect(google.eventOf('cal-1', 'slnvmrdef')?.status).toBe('confirmed');
    }).pipe(Effect.provide(engineLayer(google)));
  });

  it.effect('a created calendar arrives with the next pass', () => {
    const google = newFake();
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const client = yield* GoogleCalendarClient;
      const engine = yield* SyncEngine;
      yield* engine.syncAll();
      const created = yield* client.insertCalendar({
        accountId: 'acc-1',
        summary: 'Availability',
        timeZone: 'Europe/Vienna',
      });
      yield* engine.syncAll();
      const stored = (yield* (yield* CalendarRepo).list('acc-1')).find(
        (calendar) => calendar.id === created.id,
      );
      expect(stored).toMatchObject({ accessRole: 'owner', summary: 'Availability' });
    }).pipe(Effect.provide(engineLayer(google)));
  });

  it.effect('an account without the calendar-creation scope is refused as such', () => {
    const google = new FakeGoogle({
      calendarCreation: 'forbidden',
      calendars: [{ accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' }],
    });
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      const refused = yield* client
        .insertCalendar({ accountId: 'acc-1', summary: 'Nope' })
        .pipe(Effect.flip);
      expect(refused._tag).toBe('InsufficientScopeError');
    }).pipe(Effect.provide(engineLayer(google)));
  });

  it.effect(
    'tasks: a parent moved to another list takes its subtasks along on Google, and the next pass agrees',
    () => {
      const google = new FakeGoogle({
        calendars: [{ accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' }],
        taskLists: [
          { id: 'list-1', title: 'My Tasks' },
          { id: 'list-2', title: 'Errands' },
        ],
      });
      google.putTask('list-1', { due: '2026-08-30T00:00:00.000Z', id: 'p', title: 'Trip' });
      google.putTask('list-1', {
        id: 'c1',
        parent: 'p',
        position: '00000000000000000000',
        title: 'Pack',
      });
      google.putTask('list-1', {
        id: 'c2',
        parent: 'p',
        position: '00000000000000000001',
        title: 'Book',
      });
      return Effect.gen(function* () {
        yield* seedAccount(true);
        const engine = yield* SyncEngine;
        const mutations = yield* EventMutations;
        const repo = yield* TaskRepo;
        const rows = (listId: string) =>
          Effect.map(repo.getMirrorSource('acc-1', [listId]), (tasks) =>
            tasks.map((task) => `${task.id}<${task.parentId ?? ''}`).sort(),
          );
        yield* engine.syncAll();
        expect(yield* rows('list-1')).toEqual(['c1<p', 'c2<p', 'p<']);

        // The first attempt meets a 503: the move waits in backoff, while
        // Google still lists the tasks in the source — a pull must not
        // put back the rows the move took.
        google.failTaskMoves = 1;
        yield* mutations.moveTask({
          accountId: 'acc-1',
          draft: { dueDate: '2026-08-30', title: 'Trip' },
          target: { accountId: 'acc-1', taskListId: 'list-2' },
          taskId: 'p',
          taskListId: 'list-1',
        });
        yield* engine.syncAll();
        expect(google.taskOf('list-1', 'p')).toBeDefined();
        expect(yield* rows('list-1')).toEqual([]);
        expect(yield* rows('list-2')).toEqual(['c1<p', 'c2<p', 'p<']);
        yield* TestClock.adjust('5 minutes');
        yield* mutations.processPendingOps();
        expect(google.taskOf('list-2', 'c1')?.parent).toBe('p');
        expect(google.taskOf('list-1', 'p')).toBeUndefined();

        google.now += 60_000;
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        expect(yield* rows('list-1')).toEqual([]);
        expect(yield* rows('list-2')).toEqual(['c1<p', 'c2<p', 'p<']);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }).pipe(noYield, Effect.provide(engineLayer(google)));
    },
  );

  // A series moved a day later after a split it has not pushed yet: had
  // the move carried the cut's UNTIL past the split, the old series would
  // draw from the split again, the split's push would read the cut as
  // undone and the new series would be dropped.
  it.effect('a split pushed after its series moved a day later stays on Google', () => {
    const google = newFake();
    google.putEvent('cal-1', {
      end: { dateTime: '2026-07-01T09:30:00Z', timeZone: 'UTC' },
      id: 'daily',
      recurrence: ['RRULE:FREQ=DAILY'],
      start: { dateTime: '2026-07-01T09:00:00Z', timeZone: 'UTC' },
      status: 'confirmed',
      summary: 'Daily',
    });
    return Effect.gen(function* () {
      yield* seedAccount(false);
      const engine = yield* SyncEngine;
      const mutations = yield* EventMutations;
      yield* engine.syncAll();
      const series = { accountId: 'acc-1', calendarId: 'cal-1', masterId: 'daily' };
      yield* mutations.updateRecurring({
        ...series,
        changes: { title: 'Talks' },
        originalStartUtc: Date.parse('2026-07-04T09:00:00Z'),
        scope: 'following',
      });
      yield* mutations.updateRecurring({
        ...series,
        changes: {
          endUtc: Date.parse('2026-07-03T09:30:00Z'),
          startUtc: Date.parse('2026-07-03T09:00:00Z'),
        },
        originalStartUtc: Date.parse('2026-07-02T09:00:00Z'),
        scope: 'series',
      });
      for (let round = 0; round < 6; round += 1) {
        yield* mutations.processPendingOps();
        yield* TestClock.adjust('5 minutes');
      }
      expect(
        google
          .eventsOf('cal-1')
          .map((event) => event.summary)
          .sort(),
      ).toEqual(['Daily', 'Talks']);
      expect(google.eventsOf('cal-1').find((event) => event.id === 'daily')?.recurrence).toEqual([
        'RRULE:FREQ=DAILY;UNTIL=20260704T085959Z',
      ]);
      const masters = (yield* (yield* EventRepo).getWindow(0, Number.MAX_SAFE_INTEGER)).masters;
      expect(masters.map((master) => master.title).sort()).toEqual(['Daily', 'Talks']);
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });

  it.effect('tasks: full pass, then a watermark pass applies a deleted tombstone', () => {
    const google = newFake();
    google.putTask('list-1', { due: '2026-08-30T00:00:00.000Z', id: 't1', title: 'Pay rent' });
    google.putTask('list-1', { due: '2026-08-31T00:00:00.000Z', id: 't2', title: 'Call mum' });
    return Effect.gen(function* () {
      yield* seedAccount(true);
      const engine = yield* SyncEngine;
      const repo = yield* TaskRepo;
      const ids = () =>
        Effect.map(repo.getWindow('2026-08-01', '2026-09-30'), (rows) =>
          rows.map((row) => row.id).sort(),
        );
      yield* engine.syncAll();
      expect(yield* ids()).toEqual(['t1', 't2']);

      google.now += 60_000;
      google.deleteTaskServerSide('list-1', 't2');
      yield* TestClock.adjust('1 minute');
      yield* engine.syncAll();
      expect(yield* ids()).toEqual(['t1']);
      const listCalls = google.requests.filter(
        (call) => call.method === 'GET' && call.url.includes('/lists/list-1/tasks'),
      );
      expect(listCalls[0]!.url).not.toContain('updatedMin=');
      expect(listCalls[1]!.url).toContain('updatedMin=');
    }).pipe(noYield, Effect.provide(engineLayer(google)));
  });
});

// ---- repeating events on the fake ----

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SERIES_START = Date.parse('2026-07-06T09:00:00Z');
const isoAt = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');
/** The series' occurrence `days` after its first. */
const slotOf = (days: number): number => SERIES_START + days * DAY_MS;
const occurrenceId = (days: number): string => googleInstanceId('series', slotOf(days), false);

/** A daily series of five in cal-1, UTC, as Google has it. */
const putSeries = (google: FakeGoogle, recurrence = ['RRULE:FREQ=DAILY;COUNT=5']) =>
  google.putEvent('cal-1', {
    end: { dateTime: isoAt(SERIES_START + HOUR_MS), timeZone: 'UTC' },
    id: 'series',
    organizer: { email: 'nik@example.com', self: true },
    recurrence,
    start: { dateTime: isoAt(SERIES_START), timeZone: 'UTC' },
    status: 'confirmed',
    summary: 'Standup',
  });

/**
 * The series with its second occurrence moved three hours later and its
 * third cancelled, both by another device: `seriesWithExceptions` of
 * live/recurring.live.ts.
 */
const putSeriesWithExceptions = (google: FakeGoogle) => {
  putSeries(google);
  google.patchEventServerSide('cal-1', occurrenceId(1), {
    end: { dateTime: isoAt(slotOf(1) + 4 * HOUR_MS), timeZone: 'UTC' },
    start: { dateTime: isoAt(slotOf(1) + 3 * HOUR_MS), timeZone: 'UTC' },
  });
  google.deleteEventServerSide('cal-1', occurrenceId(2));
};

/** Where Google draws the series, as `days after its first` (a moved one: with its hours). */
const drawnOnGoogle = (google: FakeGoogle, calendarId = 'cal-1'): Array<number> =>
  google
    .instancesOf(calendarId, 'series', SERIES_START - DAY_MS, SERIES_START + 40 * DAY_MS)
    .map((instance) => (Date.parse(instance.start?.dateTime ?? '') - SERIES_START) / DAY_MS);

/** Where the calendar draws it, the same way. */
const drawnHere = Effect.gen(function* () {
  const from = SERIES_START - DAY_MS;
  const to = SERIES_START + 40 * DAY_MS;
  return assembleWindow(yield* (yield* EventRepo).getWindow(from, to), from, to)
    .filter((event) => event.recurringEventId === 'series')
    .map((event) => (event.startUtc - SERIES_START) / DAY_MS)
    .sort((a, b) => a - b);
});

/** An exception as Google has it: its status and where it starts. */
const stateOf = (google: FakeGoogle, days: number, calendarId = 'cal-1'): string => {
  const event = google.eventOf(calendarId, occurrenceId(days));
  return event === undefined ? 'none' : `${event.status} ${event.start?.dateTime ?? '-'}`;
};

const twoCalendars = () =>
  new FakeGoogle({
    calendars: [
      { accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' },
      { accessRole: 'owner', id: 'cal-2', summary: 'Work' },
    ],
  });

const tagOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.map(() => 'ok'),
    Effect.catch((error: E) => Effect.succeed(error._tag)),
  );

describe('the fake Google: repeating events', () => {
  const series = { accountId: 'acc-1', calendarId: 'cal-1' };

  it.effect('a PATCH of an occurrence makes its exception and leaves the master alone', () => {
    const google = newFake();
    putSeries(google);
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      const masterEtag = google.eventOf('cal-1', 'series')?.etag;
      const made = yield* client.patchEvent({
        ...series,
        event: { location: 'Room 4' },
        eventId: occurrenceId(1),
      });
      expect(made).toMatchObject({
        id: 'series_20260707T090000Z',
        location: 'Room 4',
        originalStartTime: { dateTime: '2026-07-07T09:00:00Z', timeZone: 'UTC' },
        recurringEventId: 'series',
        start: { dateTime: '2026-07-07T09:00:00Z', timeZone: 'UTC' },
        summary: 'Standup',
      });
      expect(made.recurrence).toBeUndefined();
      // An exception's own write leaves the master's etag alone.
      expect(google.eventOf('cal-1', 'series')?.etag).toBe(masterEtag);
      // A second PATCH changes that exception, on its own etag.
      const stale = yield* tagOf(
        client.patchEvent({
          ...series,
          baseEtag: '"stale"',
          event: { summary: 'Standup (late)' },
          eventId: occurrenceId(1),
        }),
      );
      expect(stale).toBe('ConflictError');
      const moved = yield* client.patchEvent({
        ...series,
        baseEtag: made.etag,
        event: {
          end: { dateTime: isoAt(slotOf(1) + 4 * HOUR_MS) },
          start: { dateTime: isoAt(slotOf(1) + 3 * HOUR_MS) },
        },
        eventId: occurrenceId(1),
      });
      expect(moved.location).toBe('Room 4');
      expect(moved.originalStartTime?.dateTime).toBe('2026-07-07T09:00:00Z');
      expect(drawnOnGoogle(google)).toEqual([0, 1.125, 2, 3, 4]);
      // A slot the series does not draw is no event.
      expect(
        yield* tagOf(
          client.patchEvent({ ...series, event: { summary: 'No' }, eventId: occurrenceId(7) }),
        ),
      ).toBe('NotFoundError');
      expect(google.unverified).toEqual([]);
    }).pipe(Effect.provide(engineLayer(google)));
  });

  it.effect('a DELETE of an occurrence cancels it, with or without an exception stored', () => {
    const google = newFake();
    putSeriesWithExceptions(google);
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      // No exception stored for the fourth: the DELETE makes its tombstone.
      yield* client.deleteEvent({ ...series, eventId: occurrenceId(3) });
      expect(google.eventOf('cal-1', occurrenceId(3))).toMatchObject({
        originalStartTime: { dateTime: '2026-07-09T09:00:00Z', timeZone: 'UTC' },
        recurringEventId: 'series',
        status: 'cancelled',
      });
      // The moved second: a stale If-Match is a 412, its own etag deletes.
      const moved = { ...series, eventId: occurrenceId(1) };
      expect(yield* tagOf(client.deleteEvent({ ...moved, baseEtag: '"stale"' }))).toBe(
        'ConflictError',
      );
      yield* client.deleteEvent({
        ...moved,
        baseEtag: google.eventOf('cal-1', occurrenceId(1))?.etag,
      });
      expect(drawnOnGoogle(google)).toEqual([0, 4]);
      // One already cancelled answers 410, which the client reads as gone
      // (failForStatus: SyncTokenExpiredError); events.get still shows it.
      expect(yield* tagOf(client.deleteEvent(moved))).toBe('SyncTokenExpiredError');
      expect((yield* client.getEvent(moved)).status).toBe('cancelled');
      expect(google.unverified).toEqual([]);
    }).pipe(Effect.provide(engineLayer(google)));
  });

  it.effect(
    "a master's changed text is copied onto its exceptions; every PATCH re-etags them",
    () => {
      const google = newFake();
      putSeries(google);
      google.patchEventServerSide('cal-1', occurrenceId(1), {
        location: 'Room 4',
        summary: 'Standup (late)',
      });
      google.deleteEventServerSide('cal-1', occurrenceId(2));
      return Effect.gen(function* () {
        const client = yield* GoogleCalendarClient;
        const etags = () => [1, 2].map((days) => google.eventOf('cal-1', occurrenceId(days))?.etag);
        const before = etags();
        // The title changes, the location goes out with its old value.
        yield* client.patchEvent({
          ...series,
          event: { description: 'Agenda', summary: 'Daily' },
          eventId: 'series',
        });
        expect(google.eventOf('cal-1', occurrenceId(1))).toMatchObject({
          description: 'Agenda',
          location: 'Room 4',
          summary: 'Daily',
        });
        expect(google.eventOf('cal-1', occurrenceId(1))?.updated).toBeDefined();
        expect(stateOf(google, 2)).toBe('cancelled -');
        const after = etags();
        expect(after[0]).not.toBe(before[0]);
        expect(after[1]).not.toBe(before[1]);
        // A field sent with its old value leaves the exception's own alone.
        google.patchEventServerSide('cal-1', occurrenceId(1), { summary: 'Standup (late)' });
        yield* client.patchEvent({
          ...series,
          event: { location: 'Room 9', summary: 'Daily' },
          eventId: 'series',
        });
        expect(google.eventOf('cal-1', occurrenceId(1))).toMatchObject({
          location: 'Room 9',
          summary: 'Standup (late)',
        });
        // An op queued before the PATCH carries the old etag: a 412.
        expect(
          yield* tagOf(
            client.deleteEvent({ ...series, baseEtag: after[0], eventId: occurrenceId(1) }),
          ),
        ).toBe('ConflictError');
        expect(google.unverified).toEqual([]);
      }).pipe(Effect.provide(engineLayer(google)));
    },
  );

  it.effect('a new rule keeps the exceptions it still draws and cancels the others', () => {
    const withRule = (recurrence: ReadonlyArray<string>) => {
      const google = newFake();
      putSeriesWithExceptions(google);
      const staleEtag = google.eventOf('cal-1', occurrenceId(1))?.etag;
      google.patchEventServerSide('cal-1', 'series', { recurrence });
      return { google, staleEtag };
    };
    // More occurrences: the moved one stays moved, the cancelled one
    // cancelled, both on new etags.
    const kept = withRule(['RRULE:FREQ=DAILY;COUNT=12']);
    expect(stateOf(kept.google, 1)).toBe('confirmed 2026-07-07T12:00:00Z');
    expect(stateOf(kept.google, 2)).toBe('cancelled -');
    expect(kept.google.eventOf('cal-1', occurrenceId(1))?.etag).not.toBe(kept.staleEtag);
    expect(drawnOnGoogle(kept.google)).toEqual([0, 1.125, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // A rule that skips their slots cancels both; so does an UNTIL before
    // them, and no rule at all.
    const skipped = withRule(['RRULE:FREQ=DAILY;INTERVAL=3;COUNT=3']);
    expect(drawnOnGoogle(skipped.google)).toEqual([0, 3, 6]);
    const ended = withRule(['RRULE:FREQ=DAILY;UNTIL=20260706T230000Z']);
    expect(drawnOnGoogle(ended.google)).toEqual([0]);
    const single = withRule([]);
    // No rule left cancels them whatever else the PATCH changes: the app
    // clears a rule and moves the event in one.
    const singleAndMoved = withRule([]);
    singleAndMoved.google.patchEventServerSide('cal-1', 'series', {
      end: { dateTime: isoAt(SERIES_START + 3 * HOUR_MS) },
      recurrence: [],
      start: { dateTime: isoAt(SERIES_START + 2 * HOUR_MS) },
    });
    for (const { google } of [skipped, ended, single, singleAndMoved]) {
      expect([stateOf(google, 1), stateOf(google, 2)]).toEqual(['cancelled -', 'cancelled -']);
    }
    for (const { google } of [kept, skipped, ended, single, singleAndMoved]) {
      expect(google.unverified).toEqual([]);
    }
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      // A delete of one the rule cancelled: a 412 on the etag from before
      // the PATCH, a 410 without one.
      const gone = { ...series, eventId: occurrenceId(1) };
      expect(yield* tagOf(client.deleteEvent({ ...gone, baseEtag: skipped.staleEtag }))).toBe(
        'ConflictError',
      );
      expect(yield* tagOf(client.deleteEvent(gone))).toBe('SyncTokenExpiredError');
    }).pipe(Effect.provide(engineLayer(skipped.google)));
  });

  it.effect("a master's delete takes its exceptions; a move takes them along", () => {
    const google = twoCalendars();
    putSeriesWithExceptions(google);
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      // Whole events only: an instance id is refused.
      expect(
        yield* writeStatus(
          client.moveEvent({ ...series, destination: 'cal-2', eventId: occurrenceId(1) }),
        ),
      ).toBe(400);
      yield* client.moveEvent({ ...series, destination: 'cal-2', eventId: 'series' });
      expect(google.eventOf('cal-1', 'series')?.status).toBe('cancelled');
      // The moved occurrence left with its series; the one cancelled
      // before stays the tombstone it was.
      expect(stateOf(google, 1)).toBe('none');
      expect(stateOf(google, 2)).toBe('cancelled -');
      expect(drawnOnGoogle(google, 'cal-1')).toEqual([]);
      expect(stateOf(google, 1, 'cal-2')).toBe('confirmed 2026-07-07T12:00:00Z');
      expect(stateOf(google, 2, 'cal-2')).toBe('cancelled -');
      expect(drawnOnGoogle(google, 'cal-2')).toEqual([0, 1.125, 3, 4]);
      const there = { accountId: 'acc-1', calendarId: 'cal-2' };
      yield* client.deleteEvent({ ...there, eventId: 'series' });
      expect(stateOf(google, 1, 'cal-2')).toBe('none');
      expect(yield* tagOf(client.getEvent({ ...there, eventId: occurrenceId(1) }))).toBe(
        'NotFoundError',
      );
      expect(google.unverified).toEqual([]);
    }).pipe(Effect.provide(engineLayer(google)));
  });

  it.effect('a list names a series that left with exceptions, and none of those', () => {
    const google = twoCalendars();
    putSeriesWithExceptions(google);
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      const list = (calendarId: string, syncToken?: string | undefined) =>
        Effect.map(
          client.listEvents({ accountId: 'acc-1', calendarId, params: { syncToken } }),
          (page) => ({
            items: (page.items ?? []).map((item) => `${item.id} ${item.status}`),
            token: page.nextSyncToken,
          }),
        );
      // A full list names a live series' cancelled occurrence too.
      const before = yield* list('cal-1');
      expect(before.items).toEqual([
        'series confirmed',
        `${occurrenceId(1)} confirmed`,
        `${occurrenceId(2)} cancelled`,
      ]);
      expect(google.goneWithExceptions).toEqual([]);
      yield* client.moveEvent({ ...series, destination: 'cal-2', eventId: 'series' });
      // What a list reports for the exceptions that went along is not
      // recorded: the source's names the series alone, and says so.
      expect((yield* list('cal-1', before.token)).items).toEqual(['series cancelled']);
      expect(google.goneWithExceptions).toEqual(['cal-1|series']);
      // The destination lists them all.
      const there = yield* list('cal-2');
      expect(there.items).toEqual([
        'series confirmed',
        `${occurrenceId(1)} confirmed`,
        `${occurrenceId(2)} cancelled`,
      ]);
      // Deleted there with only a cancelled occurrence left, nothing went
      // unreported: its tombstone was in the list before.
      google.deleteEventServerSide('cal-2', occurrenceId(1));
      const settled = yield* list('cal-2', there.token);
      expect(settled.items).toEqual([`${occurrenceId(1)} cancelled`]);
      google.deleteEventServerSide('cal-2', 'series');
      expect((yield* list('cal-2', settled.token)).items).toEqual(['series cancelled']);
      expect(google.goneWithExceptions).toEqual(['cal-1|series']);
      expect(google.unverified).toEqual([]);
    }).pipe(Effect.provide(engineLayer(google)));
  });

  it.effect(
    'a list reports exceptions, cancellations and a new rule: the calendar draws them',
    () => {
      const google = newFake();
      putSeries(google);
      return Effect.gen(function* () {
        yield* seedAccount(false);
        const engine = yield* SyncEngine;
        yield* engine.syncAll();
        expect(yield* drawnHere).toEqual([0, 1, 2, 3, 4]);
        // Another device moves the second occurrence and cancels the third.
        google.patchEventServerSide('cal-1', occurrenceId(1), {
          end: { dateTime: isoAt(slotOf(1) + 4 * HOUR_MS), timeZone: 'UTC' },
          start: { dateTime: isoAt(slotOf(1) + 3 * HOUR_MS), timeZone: 'UTC' },
        });
        google.deleteEventServerSide('cal-1', occurrenceId(2));
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        expect(yield* drawnHere).toEqual([0, 1.125, 3, 4]);
        expect(drawnOnGoogle(google)).toEqual([0, 1.125, 3, 4]);
        // A rename reaches the exception, a rule that skips it cancels it:
        // the delta sends both with their new etags.
        google.patchEventServerSide('cal-1', 'series', { summary: 'Daily' });
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        const events = yield* EventRepo;
        const moved = yield* events.getById('acc-1', 'cal-1', occurrenceId(1));
        expect(moved?.title).toBe('Daily');
        expect(moved?.etag).toBe(google.eventOf('cal-1', occurrenceId(1))?.etag);
        google.patchEventServerSide('cal-1', 'series', {
          recurrence: ['RRULE:FREQ=DAILY;INTERVAL=2;COUNT=4'],
        });
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        expect(drawnOnGoogle(google)).toEqual([0, 4, 6]);
        expect(yield* drawnHere).toEqual([0, 4, 6]);
        // A full list names the cancelled occurrences too: after an expired
        // token the third stays hidden.
        google.expireSyncTokens('cal-1');
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        expect(yield* drawnHere).toEqual([0, 4, 6]);
        expect(
          (yield* events.listOverrides('acc-1', 'cal-1', 'series')).map((row) => row.status),
        ).toEqual(['cancelled', 'cancelled']);
        // Deleted on Google, the series goes with its exceptions.
        google.deleteEventServerSide('cal-1', 'series');
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        expect(yield* drawnHere).toEqual([]);
        expect(yield* events.getById('acc-1', 'cal-1', 'series')).toBeNull();
        expect(google.unverified).toEqual([]);
      }).pipe(noYield, Effect.provide(engineLayer(google)));
    },
  );

  it.effect('says where it answered without a recorded Google behaviour', () => {
    const google = twoCalendars();
    putSeriesWithExceptions(google);
    return Effect.gen(function* () {
      const client = yield* GoogleCalendarClient;
      // A PATCH of a cancelled occurrence: answered as a deleted event is.
      expect(
        yield* tagOf(
          client.patchEvent({ ...series, event: { summary: 'Back' }, eventId: occurrenceId(2) }),
        ),
      ).toBe('NotFoundError');
      // New times for a series with exceptions: they stay as they are.
      yield* client.patchEvent({
        ...series,
        event: {
          end: { dateTime: isoAt(SERIES_START + 2 * HOUR_MS) },
          start: { dateTime: isoAt(SERIES_START + HOUR_MS) },
        },
        eventId: 'series',
      });
      expect(stateOf(google, 1)).toBe('confirmed 2026-07-07T12:00:00Z');
      // An exception that moved with its series has a new etag here, as
      // the series has on Google; whether Google's exception has one too
      // is not recorded, so a write on the old one says so.
      const etagBefore = google.eventOf('cal-1', occurrenceId(1))?.etag;
      yield* client.moveEvent({ ...series, destination: 'cal-2', eventId: 'series' });
      const moved = { accountId: 'acc-1', calendarId: 'cal-2', eventId: occurrenceId(1) };
      expect(yield* tagOf(client.deleteEvent({ ...moved, baseEtag: etagBefore }))).toBe(
        'ConflictError',
      );
      expect(google.unverified).toEqual([
        'events.patch of series_20260708T090000Z, a cancelled occurrence',
        'events.patch of series: new times for a series with exceptions',
        'DELETE of series_20260707T090000Z on its etag from before its series moved',
      ]);
      // Written since, its etag is its own again.
      const patched = yield* client.patchEvent({ ...moved, event: { location: 'Room 4' } });
      expect(yield* tagOf(client.deleteEvent({ ...moved, baseEtag: etagBefore }))).toBe(
        'ConflictError',
      );
      yield* client.deleteEvent({ ...moved, baseEtag: patched.etag });
      expect(google.unverified).toHaveLength(3);
      // A slot a rule dropped and a later one draws again is a plain
      // occurrence (verified live); what a list reports then is not.
      const redrawn = newFake();
      putSeriesWithExceptions(redrawn);
      redrawn.patchEventServerSide('cal-1', 'series', {
        recurrence: ['RRULE:FREQ=DAILY;INTERVAL=3;COUNT=3'],
      });
      redrawn.patchEventServerSide('cal-1', 'series', { recurrence: ['RRULE:FREQ=DAILY;COUNT=5'] });
      expect(drawnOnGoogle(redrawn)).toEqual([0, 1, 2, 3, 4]);
      expect(redrawn.unverified).toEqual([
        'events.patch of series: its rule draws series_20260707T090000Z again',
        'events.patch of series: its rule draws series_20260708T090000Z again',
      ]);
    }).pipe(Effect.provide(engineLayer(google)));
  });
});
