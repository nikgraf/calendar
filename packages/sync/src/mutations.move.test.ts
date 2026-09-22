import { makeFakeAppleCalendarClient } from '@calendar/apple-calendar';
import {
  Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  Attendee,
  CalendarInfo,
  EventRecord,
  plainDateToUtcMs,
  Temporal,
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
  type GcalEvent,
  GoogleApiError,
  GoogleCalendarClient,
  NotFoundError,
  type GoogleCalendarClientShape,
  GoogleTasksClient,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer, Scheduler } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { EventMutations } from './mutations.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Date-independent: everything hangs off a UTC day a week from today.
const base =
  plainDateToUtcMs(Temporal.Now.plainDateISO('UTC').add({ days: 7 }).toString()) + 9 * HOUR;

type Call = {
  readonly calendarId: string;
  readonly detail?: string | undefined;
  readonly kind: string;
};

const recordingGoogle = (
  calls: Array<Call>,
  overrides: Partial<GoogleCalendarClientShape> = {},
): GoogleCalendarClientShape => ({
  deleteEvent: ({ calendarId, eventId }) =>
    Effect.sync(() => {
      calls.push({ calendarId, detail: eventId, kind: 'delete' });
    }),
  getColors: () => Effect.succeed({ calendar: {} }),
  insertEvent: ({ calendarId, event }) =>
    Effect.sync(() => {
      calls.push({ calendarId, detail: event.summary, kind: 'insert' });
      return { ...(event as GcalEvent), etag: '"new"', status: 'confirmed' };
    }),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  moveEvent: ({ calendarId, destination, eventId }) =>
    Effect.sync(() => {
      calls.push({ calendarId, detail: destination, kind: 'move' });
      return {
        end: { dateTime: new Date(base + HOUR).toISOString() },
        etag: '"moved"',
        id: eventId,
        organizer: { email: 'nik@nikgraf.com', self: true },
        start: { dateTime: new Date(base).toISOString() },
        status: 'confirmed',
        summary: 'Moved',
      };
    }),
  patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
  patchEvent: ({ calendarId, event, eventId }) =>
    Effect.sync(() => {
      calls.push({ calendarId, detail: event.summary, kind: 'patch' });
      return {
        end: { dateTime: new Date(base + HOUR).toISOString() },
        etag: '"patched"',
        id: eventId,
        start: { dateTime: new Date(base).toISOString() },
        status: 'confirmed',
        summary: event.summary,
      };
    }),
  ...overrides,
});

const appleFake = () =>
  makeFakeAppleCalendarClient({
    calendars: ['ek-home', 'ek-work'].map((id) => ({
      allowsModifications: true,
      id,
      isDefault: id === 'ek-home',
      sourceTitle: 'iCloud',
      sourceType: 'calDAV' as const,
      title: id,
      type: 'calDAV' as const,
    })),
    events: [
      {
        event: {
          calendarId: 'ek-home',
          description: 'Bring the forms',
          endUtc: base + HOUR,
          hasRecurrence: false,
          id: 'ek-single',
          isAllDay: false,
          isDetached: false,
          location: 'Dr. Weiss',
          startUtc: base,
          status: 'confirmed',
          timeZone: 'Europe/Vienna',
          title: 'Dentist',
          updatedAt: 1,
          url: 'https://example.com/agenda',
        },
      },
      {
        event: {
          calendarId: 'ek-home',
          endUtc: base + HOUR,
          hasRecurrence: true,
          id: 'ek-series',
          isAllDay: false,
          isDetached: false,
          occurrenceStartUtc: base,
          startUtc: base,
          status: 'confirmed',
          timeZone: 'UTC',
          title: 'Standup',
          updatedAt: 1,
        },
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'],
      },
    ],
  });

// The detached drain must not run between a move and the queue assertion
// (see docs: every new migration moves the fiber yield point).
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

const testLayer = (
  google: GoogleCalendarClientShape,
  apple: ReturnType<typeof makeFakeAppleCalendarClient>,
) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(appleCalendarServicesLayer(apple.client)),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, google)),
    Layer.provideMerge(
      Layer.succeed(GoogleTasksClient, {
        deleteTask: () => Effect.die('not used'),
        insertTask: () => Effect.die('not used'),
        listTaskLists: () => Effect.die('not used'),
        listTasks: () => Effect.die('not used'),
        patchTask: () => Effect.die('not used'),
      }),
    ),
  );

const account = (id: string, email: string, provider: 'apple' | 'google' = 'google') =>
  new Account({
    contactsEnabled: false,
    createdAt: 1,
    email,
    id,
    provider,
    status: 'ok',
    tasksEnabled: false,
  });

const calendar = (accountId: string, id: string, provider: 'apple' | 'google' = 'google') =>
  new CalendarInfo({
    accessRole: id === 'cal-readonly' ? 'reader' : 'owner',
    accountId,
    colorHex: '#3b82f6',
    id,
    isPrimary: false,
    isVisible: true,
    provider,
    summary: id,
    timeZone: 'Europe/Vienna',
  });

const googleEvent = (overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'acc-1',
    calendarId: 'cal-1',
    endUtc: base + HOUR,
    etag: '"e1"',
    id: 'evt-a',
    isAllDay: false,
    organizerEmail: 'nik@nikgraf.com',
    startTimeZone: 'Europe/Vienna',
    startUtc: base,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title: 'Planning',
    updatedAt: 1,
    ...overrides,
  });

const seed = (events: ReadonlyArray<EventRecord> = []) =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo;
    yield* accounts.upsert(account('acc-1', 'nik@nikgraf.com'));
    yield* accounts.upsert(account('acc-2', 'other@example.com'));
    yield* accounts.upsert(account(APPLE_CALENDAR_ACCOUNT_ID, '', 'apple'));
    yield* (yield* CalendarRepo).upsertMany([
      calendar('acc-1', 'cal-1'),
      calendar('acc-1', 'cal-2'),
      calendar('acc-1', 'cal-2b'),
      calendar('acc-1', 'cal-readonly'),
      calendar('acc-2', 'cal-3'),
      calendar(APPLE_CALENDAR_ACCOUNT_ID, 'ek-home', 'apple'),
      calendar(APPLE_CALENDAR_ACCOUNT_ID, 'ek-work', 'apple'),
    ]);
    yield* (yield* EventRepo).upsertMany(events);
  });

const rowAt = (accountId: string, calendarId: string, eventId: string) =>
  Effect.gen(function* () {
    return yield* (yield* EventRepo).getById(accountId, calendarId, eventId);
  });

const queued = Effect.gen(function* () {
  return yield* (yield* PendingOpRepo).listAll();
});

const move = (from: [string, string, string], to: [string, string]) => ({
  accountId: from[0],
  calendarId: from[1],
  eventId: from[2],
  target: { accountId: to[0], calendarId: to[1] },
});

describe('moveEvent inside one Google account', () => {
  it.effect('queues a server move and re-queues a pending edit behind it', () => {
    const calls: Array<Call> = [];
    return Effect.gen(function* () {
      yield* seed([googleEvent()]);
      const mutations = yield* EventMutations;
      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        changes: { title: 'Planning (edited)' },
        eventId: 'evt-a',
      });
      calls.length = 0;
      expect(
        yield* mutations.previewMove(move(['acc-1', 'cal-1', 'evt-a'], ['acc-1', 'cal-2'])),
      ).toEqual({
        attendees: 0,
        meetingLink: false,
        modifiedOccurrences: 0,
        unsupportedRuleParts: [],
      });
      yield* mutations.moveEvent(move(['acc-1', 'cal-1', 'evt-a'], ['acc-1', 'cal-2']));

      expect(yield* rowAt('acc-1', 'cal-1', 'evt-a')).toBeNull();
      expect((yield* rowAt('acc-1', 'cal-2', 'evt-a'))?.title).toBe('Planning (edited)');

      yield* mutations.processPendingOps();
      // The first drain may already have run from the kicks; either way the
      // server saw the move first, then the edit against the destination.
      yield* mutations.processPendingOps();
      expect(calls.map((call) => `${call.kind}:${call.calendarId}`)).toEqual([
        'move:cal-1',
        'patch:cal-2',
      ]);
      expect(yield* queued).toEqual([]);
      expect((yield* rowAt('acc-1', 'cal-2', 'evt-a'))?.syncStatus).toBe('synced');
    }).pipe(Effect.provide(testLayer(recordingGoogle(calls), appleFake())));
  });

  it.effect('an edit queued behind a move waits while the move is in backoff', () => {
    const calls: Array<Call> = [];
    const google = recordingGoogle(calls, {
      moveEvent: () =>
        Effect.sync(() => calls.push({ calendarId: 'cal-1', kind: 'move-failed' })).pipe(
          Effect.andThen(Effect.fail(new ApiUnavailableError({ cause: 'down', status: 503 }))),
        ),
    });
    return Effect.gen(function* () {
      yield* seed([googleEvent()]);
      const mutations = yield* EventMutations;
      yield* mutations.moveEvent(move(['acc-1', 'cal-1', 'evt-a'], ['acc-1', 'cal-2']));
      yield* mutations.updateEvent({
        accountId: 'acc-1',
        calendarId: 'cal-2',
        changes: { title: 'After the move' },
        eventId: 'evt-a',
      });
      yield* mutations.processPendingOps();
      yield* mutations.processPendingOps();
      expect(calls.some((call) => call.kind === 'patch')).toBe(false);
      const ops = yield* queued;
      expect(ops.map((op) => op.kind)).toEqual(['move', 'update']);
    }).pipe(Effect.provide(testLayer(google, appleFake())));
  });

  it.effect('a rejected move puts the event back where the server has it', () => {
    const calls: Array<Call> = [];
    const google = recordingGoogle(calls, {
      moveEvent: () =>
        Effect.fail(new GoogleApiError({ message: 'forbiddenForNonOrganizer', status: 403 })),
    });
    return Effect.gen(function* () {
      yield* seed([googleEvent()]);
      const mutations = yield* EventMutations;
      yield* mutations.moveEvent(move(['acc-1', 'cal-1', 'evt-a'], ['acc-1', 'cal-2']));
      yield* mutations.processPendingOps();
      expect(yield* rowAt('acc-1', 'cal-2', 'evt-a')).toBeNull();
      expect((yield* rowAt('acc-1', 'cal-1', 'evt-a'))?.syncStatus).toBe('synced');
      expect(yield* queued).toEqual([]);
    }).pipe(Effect.provide(testLayer(google, appleFake())));
  });

  it.effect('moves a series with its exceptions', () => {
    const calls: Array<Call> = [];
    const master = googleEvent({ id: 'ser', recurrence: ['RRULE:FREQ=DAILY;COUNT=5'] });
    const override = googleEvent({
      endUtc: base + DAY + 2 * HOUR,
      id: 'ser_20300101T090000Z',
      originalStartUtc: base + DAY,
      recurringEventId: 'ser',
      startUtc: base + DAY + HOUR,
    });
    return Effect.gen(function* () {
      yield* seed([master, override]);
      const mutations = yield* EventMutations;
      yield* mutations.moveEvent(move(['acc-1', 'cal-1', 'ser'], ['acc-1', 'cal-2']));
      expect(yield* rowAt('acc-1', 'cal-2', override.id)).not.toBeNull();
      yield* mutations.processPendingOps();
      expect(calls.map((call) => call.kind)).toEqual(['move']);
      expect((yield* rowAt('acc-1', 'cal-2', override.id))?.syncStatus).toBe('synced');
    }).pipe(Effect.provide(testLayer(recordingGoogle(calls), appleFake())));
  });

  it.effect('refuses guests, single occurrences and read-only targets', () => {
    return Effect.gen(function* () {
      yield* seed([
        googleEvent({ id: 'invite', organizerEmail: 'boss@example.com' }),
        googleEvent({ id: 'ser_1', originalStartUtc: base, recurringEventId: 'ser' }),
        googleEvent({ id: 'own' }),
      ]);
      const mutations = yield* EventMutations;
      const invite = yield* Effect.flip(
        mutations.moveEvent(move(['acc-1', 'cal-1', 'invite'], ['acc-1', 'cal-2'])),
      );
      expect(invite._tag).toBe('NotOrganizerError');
      const instance = yield* Effect.flip(
        mutations.moveEvent(move(['acc-1', 'cal-1', 'ser_1'], ['acc-1', 'cal-2'])),
      );
      expect(instance._tag).toBe('RecurringEditUnsupportedError');
      const readOnly = yield* Effect.flip(
        mutations.moveEvent(move(['acc-1', 'cal-1', 'own'], ['acc-1', 'cal-readonly'])),
      );
      expect(readOnly._tag).toBe('CalendarNotWritableError');
    }).pipe(Effect.provide(testLayer(recordingGoogle([]), appleFake())));
  });
});

describe('moveEvent across accounts and providers', () => {
  it.effect(
    'Google → Apple copies without guests, keeps the link as the URL, deletes the source',
    () => {
      const apple = appleFake();
      const invited = googleEvent({
        attendees: [
          new Attendee({
            email: 'nik@nikgraf.com',
            isOrganizer: true,
            isSelf: true,
            responseStatus: 'accepted',
          }),
          new Attendee({ email: 'ana@example.com', responseStatus: 'accepted' }),
        ],
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      });
      return Effect.gen(function* () {
        yield* seed([invited]);
        const mutations = yield* EventMutations;
        const params = move(['acc-1', 'cal-1', 'evt-a'], [APPLE_CALENDAR_ACCOUNT_ID, 'ek-work']);
        expect(yield* mutations.previewMove(params)).toEqual({
          attendees: 1,
          meetingLink: false,
          modifiedOccurrences: 0,
          unsupportedRuleParts: [],
        });
        yield* mutations.moveEvent(params);
        const created = [...apple.state.series.values()].find(
          (entry) => entry.event.title === 'Planning',
        );
        expect(created?.event.calendarId).toBe('ek-work');
        expect(created?.event.url).toBe('https://meet.google.com/abc-defg-hij');
        expect(created?.event.attendees).toBeUndefined();
        expect(created?.event.timeZone).toBe('Europe/Vienna');
        expect(yield* rowAt('acc-1', 'cal-1', 'evt-a')).toBeNull();
        expect((yield* queued).map((op) => `${op.kind}:${op.eventId}`)).toEqual(['delete:evt-a']);
      }).pipe(noYield, Effect.provide(testLayer(recordingGoogle([]), apple)));
    },
  );

  it.effect(
    'Google → Apple moves a series as its rule, dropping what EventKit cannot store',
    () => {
      const apple = appleFake();
      const master = googleEvent({
        id: 'ser',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE:20300101T090000Z'],
      });
      const override = googleEvent({
        id: 'ser_20300102T090000Z',
        originalStartUtc: base + 2 * DAY,
        recurringEventId: 'ser',
      });
      return Effect.gen(function* () {
        yield* seed([master, override]);
        const mutations = yield* EventMutations;
        const params = move(['acc-1', 'cal-1', 'ser'], [APPLE_CALENDAR_ACCOUNT_ID, 'ek-home']);
        expect(yield* mutations.previewMove(params)).toMatchObject({
          modifiedOccurrences: 1,
          unsupportedRuleParts: ['EXDATE'],
        });
        yield* mutations.moveEvent(params);
        const created = [...apple.state.series.values()].find(
          (entry) => entry.event.title === 'Planning',
        );
        expect(created?.rules).toEqual([
          { byDay: [{ weekday: 'MO' }, { weekday: 'WE' }], freq: 'weekly', interval: 1 },
        ]);
        expect(yield* rowAt('acc-1', 'cal-1', 'ser')).toBeNull();
        expect(yield* rowAt('acc-1', 'cal-1', override.id)).toBeNull();
      }).pipe(Effect.provide(testLayer(recordingGoogle([]), apple)));
    },
  );

  it.effect('a move the server cannot find puts the rows back instead of deleting them', () => {
    const google = recordingGoogle([], {
      moveEvent: () => Effect.fail(new NotFoundError({ resource: 'event' })),
    });
    return Effect.gen(function* () {
      yield* seed([googleEvent()]);
      const mutations = yield* EventMutations;
      yield* mutations.moveEvent(move(['acc-1', 'cal-1', 'evt-a'], ['acc-1', 'cal-2']));
      yield* mutations.processPendingOps();
      // A 404 may be the destination calendar: the event is still where the
      // server last had it, and an incremental pull would never resend it.
      expect((yield* rowAt('acc-1', 'cal-1', 'evt-a'))?.syncStatus).toBe('synced');
      expect(yield* rowAt('acc-1', 'cal-2', 'evt-a')).toBeNull();
      expect(yield* queued).toEqual([]);
    }).pipe(Effect.provide(testLayer(google, appleFake())));
  });

  it.effect('a second move queued behind the first keeps the rows at its own target', () => {
    const calls: Array<Call> = [];
    let serverUp = false;
    const google = recordingGoogle(calls, {
      moveEvent: ({ calendarId, destination, eventId }) =>
        serverUp
          ? Effect.sync(() => {
              calls.push({ calendarId, detail: destination, kind: 'move' });
              return {
                end: { dateTime: new Date(base + HOUR).toISOString() },
                etag: `"moved-${destination}"`,
                id: eventId,
                organizer: { email: 'nik@nikgraf.com', self: true },
                start: { dateTime: new Date(base).toISOString() },
                status: 'confirmed',
                summary: 'Planning',
              };
            })
          : Effect.fail(new ApiUnavailableError({ cause: 'down', status: 503 })),
    });
    return Effect.gen(function* () {
      yield* seed([googleEvent()]);
      const mutations = yield* EventMutations;
      yield* mutations.moveEvent(move(['acc-1', 'cal-1', 'evt-a'], ['acc-1', 'cal-2']));
      yield* mutations.moveEvent(move(['acc-1', 'cal-2', 'evt-a'], ['acc-1', 'cal-2b']));
      serverUp = true;
      const pending = yield* PendingOpRepo;
      // Both moves are due now (the failed first one is in backoff).
      for (const op of yield* pending.listAll()) {
        yield* pending.markFailed(op.id, 0, 0, '');
      }
      yield* mutations.processPendingOps();
      yield* mutations.processPendingOps();
      expect(calls.filter((call) => call.kind === 'move').map((call) => call.detail)).toEqual([
        'cal-2',
        'cal-2b',
      ]);
      expect(yield* rowAt('acc-1', 'cal-2', 'evt-a')).toBeNull();
      expect((yield* rowAt('acc-1', 'cal-2b', 'evt-a'))?.syncStatus).toBe('synced');
      expect(yield* queued).toEqual([]);
    }).pipe(Effect.provide(testLayer(google, appleFake())));
  });

  it.effect(
    'Apple → Google moves a meeting the user organizes, never one they were invited to',
    () => {
      const apple = makeFakeAppleCalendarClient({
        calendars: [
          {
            allowsModifications: true,
            id: 'ek-home',
            isDefault: true,
            sourceTitle: 'iCloud',
            sourceType: 'calDAV',
            title: 'Home',
            type: 'calDAV',
          },
        ],
        events: [
          {
            event: {
              attendees: [
                { email: 'ana@example.com', isOrganizer: false, isSelf: false, status: 'accepted' },
              ],
              calendarId: 'ek-home',
              endUtc: base + HOUR,
              hasRecurrence: false,
              id: 'ek-mine',
              isAllDay: false,
              isDetached: false,
              organizerEmail: 'me@icloud.com',
              organizerIsSelf: true,
              startUtc: base,
              status: 'confirmed',
              timeZone: 'UTC',
              title: 'My meeting',
              updatedAt: 1,
            },
          },
          {
            event: {
              attendees: [
                { email: 'me@icloud.com', isOrganizer: false, isSelf: true, status: 'accepted' },
              ],
              calendarId: 'ek-home',
              endUtc: base + HOUR,
              hasRecurrence: false,
              id: 'ek-theirs',
              isAllDay: false,
              isDetached: false,
              organizerEmail: 'boss@example.com',
              startUtc: base,
              status: 'confirmed',
              timeZone: 'UTC',
              title: 'Their meeting',
              updatedAt: 1,
            },
          },
        ],
      });
      return Effect.gen(function* () {
        yield* seed();
        const mutations = yield* EventMutations;
        const mine = move([APPLE_CALENDAR_ACCOUNT_ID, 'ek-home', 'ek-mine'], ['acc-1', 'cal-2']);
        expect((yield* mutations.previewMove(mine)).attendees).toBe(1);
        yield* mutations.moveEvent(mine);
        expect(apple.state.series.has('ek-mine')).toBe(false);
        expect((yield* queued).map((op) => op.payload?.title)).toEqual(['My meeting']);
        const theirs = yield* Effect.flip(
          mutations.moveEvent(
            move([APPLE_CALENDAR_ACCOUNT_ID, 'ek-home', 'ek-theirs'], ['acc-1', 'cal-2']),
          ),
        );
        expect(theirs._tag).toBe('NotOrganizerError');
      }).pipe(Effect.provide(testLayer(recordingGoogle([]), apple)));
    },
  );

  it.effect('Apple → Google queues a create and removes the event from EventKit', () => {
    const apple = appleFake();
    return Effect.gen(function* () {
      yield* seed();
      const mutations = yield* EventMutations;
      yield* mutations.moveEvent(
        move([APPLE_CALENDAR_ACCOUNT_ID, 'ek-home', 'ek-single'], ['acc-1', 'cal-2']),
      );
      expect(apple.state.series.has('ek-single')).toBe(false);
      const ops = yield* queued;
      expect(ops.map((op) => op.kind)).toEqual(['create']);
      const created = ops[0]?.payload;
      expect(created?.calendarId).toBe('cal-2');
      expect(created?.title).toBe('Dentist');
      expect(created?.location).toBe('Dr. Weiss');
      expect(created?.description).toBe('Bring the forms\n\nhttps://example.com/agenda');
      expect(created?.startTimeZone).toBe('Europe/Vienna');
    }).pipe(Effect.provide(testLayer(recordingGoogle([]), apple)));
  });

  it.effect('Apple → Apple re-homes the whole series inside EventKit', () => {
    const apple = appleFake();
    return Effect.gen(function* () {
      yield* seed();
      const mutations = yield* EventMutations;
      const params = move(
        [APPLE_CALENDAR_ACCOUNT_ID, 'ek-home', 'ek-series'],
        [APPLE_CALENDAR_ACCOUNT_ID, 'ek-work'],
      );
      expect(yield* mutations.previewMove(params)).toMatchObject({ modifiedOccurrences: 0 });
      yield* mutations.moveEvent(params);
      expect(apple.state.series.get('ek-series')?.event.calendarId).toBe('ek-work');
      expect(yield* queued).toEqual([]);
    }).pipe(Effect.provide(testLayer(recordingGoogle([]), apple)));
  });

  it.effect('Google → another Google account copies and deletes through the queue', () => {
    return Effect.gen(function* () {
      yield* seed([googleEvent()]);
      const mutations = yield* EventMutations;
      yield* mutations.moveEvent(move(['acc-1', 'cal-1', 'evt-a'], ['acc-2', 'cal-3']));
      const ops = yield* queued;
      expect(ops.map((op) => `${op.accountId}:${op.kind}`).sort()).toEqual([
        'acc-1:delete',
        'acc-2:create',
      ]);
      expect(yield* rowAt('acc-1', 'cal-1', 'evt-a')).toBeNull();
    }).pipe(Effect.provide(testLayer(recordingGoogle([]), appleFake())));
  });
});
