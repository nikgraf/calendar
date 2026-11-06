import {
  type AppleCalendarClientShape,
  type AppleCalendarJson,
  AppleCalendarRequestError,
  type AppleEventJson,
  makeFakeAppleCalendarClient,
  withSeriesIdentity,
} from '@calendar/apple-calendar';
import {
  Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  encodeMirrorUrl,
  mirrorKeyHash,
  mirrorTag,
  plainDateToUtcMs,
  Temporal,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, reposLayer, runMigrations } from '@calendar/db';
import { EVENTS_KEY } from '@calendar/db/keys';
import {
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GooglePeopleClient,
  GoogleTasksClient,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer, Reactivity } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import { AppleCalendarEvents, appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { SyncEngine } from './engine.ts';
import { loadEventsInRange, loadEventsInRangeOrFail } from './eventsInRange.ts';
import { EventMutations } from './mutations.ts';

/** Google must never be called for the Apple Calendar account. */
const inertGoogle: GoogleCalendarClientShape = {
  deleteEvent: () => Effect.die('unexpected deleteEvent'),
  getColors: () => Effect.succeed({ calendar: {} }),
  getEvent: () => Effect.die('unexpected get'),
  insertCalendar: () => Effect.die('not used'),
  insertEvent: () => Effect.die('unexpected insertEvent'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  moveEvent: () => Effect.die('unexpected moveEvent'),
  patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
  patchEvent: () => Effect.die('unexpected patchEvent'),
  replaceEvent: () => Effect.die('not used'),
};

const testLayer = (fake: ReturnType<typeof makeFakeAppleCalendarClient>) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(appleCalendarServicesLayer(fake.client)),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, inertGoogle)),
    Layer.provideMerge(
      Layer.succeed(GoogleTasksClient, {
        deleteTask: () => Effect.die('not used'),
        insertTask: () => Effect.die('not used'),
        listTaskLists: () => Effect.die('not used'),
        listTasks: () => Effect.die('not used'),
        moveTask: () => Effect.die('not used'),
        patchTask: () => Effect.die('not used'),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(GooglePeopleClient, {
        listConnections: () => Effect.die('not used'),
        listOtherContacts: () => Effect.die('not used'),
      }),
    ),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
  );

// Date-independent: the series starts a few days before today, in UTC.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const today = Temporal.Now.plainDateISO('UTC');
const seriesStart = plainDateToUtcMs(today.subtract({ days: 3 }).toString()) + 9 * HOUR;
const window = { end: seriesStart + 30 * DAY, start: seriesStart - DAY };

const calendar = (overrides: Partial<AppleCalendarJson>): AppleCalendarJson => ({
  allowsModifications: true,
  colorHex: '#1badf8',
  id: 'ek-home',
  isDefault: true,
  sourceTitle: 'iCloud',
  sourceType: 'calDAV',
  title: 'Home',
  type: 'calDAV',
  ...overrides,
});

const calendars: ReadonlyArray<AppleCalendarJson> = [
  calendar({}),
  calendar({ id: 'ek-work', isDefault: false, title: 'Work' }),
  calendar({
    allowsModifications: false,
    id: 'ek-holidays',
    isDefault: false,
    sourceTitle: 'Subscribed Calendars',
    sourceType: 'subscribed',
    title: 'Holidays',
    type: 'subscription',
  }),
  calendar({
    allowsModifications: false,
    id: 'ek-birthdays',
    isDefault: false,
    sourceTitle: 'Other',
    sourceType: 'birthdays',
    title: 'Birthdays',
    type: 'birthday',
  }),
  // A Google account the user also added to Calendar.app.
  calendar({ id: 'ek-google-dup', isDefault: false, sourceTitle: 'NIK@example.com', title: 'Nik' }),
];

const event = (overrides: Partial<AppleEventJson>): AppleEventJson => ({
  calendarId: 'ek-home',
  endUtc: seriesStart + HOUR,
  hasRecurrence: false,
  id: 'ek-single',
  isAllDay: false,
  isDetached: false,
  startUtc: seriesStart,
  status: 'confirmed',
  timeZone: 'UTC',
  title: 'Dentist',
  updatedAt: 1,
  ...overrides,
});

const fakeWith = () =>
  makeFakeAppleCalendarClient({
    calendars,
    events: [
      { event: event({ endUtc: seriesStart + DAY + HOUR, startUtc: seriesStart + DAY }) },
      {
        event: event({
          hasRecurrence: true,
          id: 'ek-series',
          occurrenceStartUtc: seriesStart,
          title: 'Standup',
        }),
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
      },
      { event: event({ calendarId: 'ek-work', id: 'ek-work-1', title: 'Review' }) },
      { event: event({ calendarId: 'ek-google-dup', id: 'ek-dup-1', title: 'Duplicate' }) },
    ],
  });

const appleAccount = new Account({
  contactsEnabled: false,
  createdAt: 1,
  displayName: 'Apple Calendar',
  email: '',
  id: APPLE_CALENDAR_ACCOUNT_ID,
  provider: 'apple',
  status: 'ok',
  tasksEnabled: false,
});

const connected = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  yield* accounts.upsert(appleAccount);
  yield* accounts.upsert(
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'nik@example.com',
      id: 'acc-google',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  );
  yield* (yield* SyncEngine).syncAll();
});

const eventsInWindow = Effect.gen(function* () {
  return yield* (yield* AppleCalendarEvents).eventsInRange(window.start, window.end);
});

const settle = Effect.repeat(Effect.yieldNow, { times: 20 });

const accountStatus = Effect.gen(function* () {
  return (yield* (yield* AccountRepo).get(APPLE_CALENDAR_ACCOUNT_ID))?.status;
});

describe('Apple Calendar mirror and read-through', () => {
  it.effect('mirrors calendars, skipping birthdays and Google doubles', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const mirrored = yield* (yield* CalendarRepo).list(APPLE_CALENDAR_ACCOUNT_ID);
      expect(mirrored.map((entry) => entry.id).sort()).toEqual([
        'ek-holidays',
        'ek-home',
        'ek-work',
      ]);
      const byId = new Map(mirrored.map((entry) => [entry.id, entry]));
      expect(byId.get('ek-home')?.isPrimary).toBe(true);
      expect(byId.get('ek-home')?.provider).toBe('apple');
      expect(byId.get('ek-home')?.sourceTitle).toBe('iCloud');
      expect(byId.get('ek-holidays')?.accessRole).toBe('reader');
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('keeps the local visibility toggle and purges calendars gone from EventKit', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const repo = yield* CalendarRepo;
      yield* repo.setVisible(APPLE_CALENDAR_ACCOUNT_ID, 'ek-work', false);
      fake.state.calendars.delete('ek-holidays');
      yield* (yield* SyncEngine).syncAll();
      const mirrored = new Map(
        (yield* repo.list(APPLE_CALENDAR_ACCOUNT_ID)).map((entry) => [entry.id, entry]),
      );
      expect(mirrored.has('ek-holidays')).toBe(false);
      expect(mirrored.get('ek-work')?.isVisible).toBe(false);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('reads events live, expanded by EventKit, from visible calendars only', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const titles = (yield* eventsInWindow).map((entry) => entry.title);
      expect(titles.filter((title) => title === 'Standup')).toHaveLength(4);
      expect(titles).toContain('Dentist');
      expect(titles).toContain('Review');
      expect(titles).not.toContain('Duplicate');

      yield* (yield* CalendarRepo).setVisible(APPLE_CALENDAR_ACCOUNT_ID, 'ek-work', false);
      yield* (yield* AppleCalendarEvents).invalidate;
      expect((yield* eventsInWindow).map((entry) => entry.title)).not.toContain('Review');
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('never draws a calendar mirror’s copy', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const marker = encodeMirrorUrl({
        contentHash: '0123456789abcdef',
        keyHash: mirrorKeyHash('mirror-1', 'g|cal|evt'),
        rev: 1000,
        tag: mirrorTag('mirror-1'),
      });
      yield* fake.client.applyBatch({
        ops: [
          {
            calendarId: 'ek-home',
            event: {
              endUtc: seriesStart + HOUR,
              startUtc: seriesStart,
              title: 'Busy',
              url: marker,
            },
            kind: 'create',
          },
          {
            calendarId: 'ek-home',
            event: {
              endUtc: seriesStart + HOUR,
              startUtc: seriesStart,
              title: 'Own event with a link',
              url: 'https://example.com/agenda',
            },
            kind: 'create',
          },
        ],
      });
      yield* (yield* AppleCalendarEvents).invalidate;
      const titles = (yield* eventsInWindow).map((entry) => entry.title);
      expect(titles).toContain('Own event with a link');
      expect(titles).not.toContain('Busy');
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('reads EventKit on every range and repaints on a store change', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const reactivity = yield* Reactivity;
      let repaints = 0;
      reactivity.registerUnsafe([EVENTS_KEY], () => {
        repaints += 1;
      });
      yield* eventsInWindow;
      yield* eventsInWindow;
      // No cache: a read never answers from before a write.
      expect(fake.state.calls.filter((call) => call === 'events')).toHaveLength(2);
      // The change stream runs on a forked fiber: let it subscribe, take
      // the element, and finish the invalidation around the debounce.
      yield* settle;
      fake.state.emitChange();
      yield* settle;
      yield* TestClock.adjust('2 seconds');
      yield* settle;
      expect(repaints).toBe(1);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('flags lost access and heals when it returns', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      fake.state.authorization = 'denied';
      yield* (yield* AppleCalendarEvents).invalidate;
      expect(yield* eventsInWindow).toEqual([]);
      expect(yield* accountStatus).toBe('reauth_required');
      fake.state.authorization = 'fullAccess';
      yield* (yield* SyncEngine).syncAll();
      expect(yield* accountStatus).toBe('ok');
      expect((yield* eventsInWindow).length).toBeGreaterThan(0);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect(
    'a strict read fails where EventKit could not be read, so a lookup never takes it for "gone"',
    () => {
      const fake = fakeWith();
      let failing = false;
      const client: AppleCalendarClientShape = {
        ...fake.client,
        events: (params) =>
          failing
            ? Effect.fail(new AppleCalendarRequestError({ message: 'timed out', method: 'events' }))
            : fake.client.events(params),
      };
      return Effect.gen(function* () {
        yield* connected;
        const apple = yield* AppleCalendarEvents;
        expect((yield* apple.eventsInRangeOrFail(window.start, window.end)).length).toBeGreaterThan(
          0,
        );
        failing = true;
        // A grid draws the rest without them…
        expect(yield* apple.eventsInRange(window.start, window.end)).toEqual([]);
        expect(yield* loadEventsInRange(window.start, window.end)).toEqual([]);
        // …while a lookup of an Apple event (`strictApple`) hears that it could not see.
        expect((yield* Effect.flip(apple.eventsInRangeOrFail(window.start, window.end)))._tag).toBe(
          'AppleCalendarRequestError',
        );
        expect((yield* Effect.flip(loadEventsInRangeOrFail(window.start, window.end)))._tag).toBe(
          'AppleCalendarRequestError',
        );
        expect(yield* accountStatus).toBe('ok');

        // Lost access: the plain read flags the account and answers nothing
        // from then on; a strict read still asks, so it fails…
        failing = false;
        fake.state.authorization = 'denied';
        expect(yield* apple.eventsInRange(window.start, window.end)).toEqual([]);
        expect(yield* accountStatus).toBe('reauth_required');
        expect((yield* Effect.flip(apple.eventsInRangeOrFail(window.start, window.end)))._tag).toBe(
          'AppleCalendarAccessError',
        );
        // …and reads again once access is back, before a pass clears the flag.
        fake.state.authorization = 'fullAccess';
        expect((yield* apple.eventsInRangeOrFail(window.start, window.end)).length).toBeGreaterThan(
          0,
        );
      }).pipe(Effect.provide(testLayer({ ...fake, client })));
    },
  );

  it.effect('skips a pass without flagging the account when there is no bridge', () => {
    const fake = fakeWith();
    fake.state.authorization = 'unavailable';
    return Effect.gen(function* () {
      yield* connected;
      expect(yield* accountStatus).toBe('ok');
      expect(yield* (yield* CalendarRepo).list(APPLE_CALENDAR_ACCOUNT_ID)).toEqual([]);
    }).pipe(Effect.provide(testLayer(fake)));
  });
});

const series = (fake: ReturnType<typeof makeFakeAppleCalendarClient>) =>
  Effect.runSync(fake.client.events({ endUtc: window.end, startUtc: window.start })).filter(
    (entry) => entry.title.startsWith('Standup'),
  );

/** The weekly series of `fakeWith`, as a recurring write names it. */
const standup = {
  accountId: APPLE_CALENDAR_ACCOUNT_ID,
  calendarId: 'ek-home',
  masterId: 'ek-series',
};

/** How often EventKit was asked to delete. */
const deletes = (fake: ReturnType<typeof makeFakeAppleCalendarClient>) =>
  fake.state.calls.filter((call) => call === 'delete').length;

describe('Apple Calendar mutations', () => {
  it.effect('creates in EventKit and returns the final record', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const created = yield* (yield* EventMutations).createEvent({
        accountId: APPLE_CALENDAR_ACCOUNT_ID,
        calendarId: 'ek-work',
        endUtc: seriesStart + 2 * HOUR,
        isAllDay: false,
        recurrence: ['RRULE:FREQ=DAILY;COUNT=2'],
        startTimeZone: 'UTC',
        startUtc: seriesStart + HOUR,
        title: 'Planning',
      });
      expect(created.accountId).toBe(APPLE_CALENDAR_ACCOUNT_ID);
      expect(created.recurringEventId).toBe(
        fake.state.series.get(created.recurringEventId ?? '')?.event.id,
      );
      expect((yield* eventsInWindow).filter((entry) => entry.title === 'Planning')).toHaveLength(2);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('refuses what EventKit cannot store instead of dropping it', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const mutations = yield* EventMutations;
      const base = {
        accountId: APPLE_CALENDAR_ACCOUNT_ID,
        calendarId: 'ek-home',
        endUtc: seriesStart + HOUR,
        isAllDay: false,
        startUtc: seriesStart,
        title: 'X',
      };
      const rule = yield* Effect.flip(
        mutations.createEvent({ ...base, recurrence: ['RRULE:FREQ=DAILY;BYHOUR=9,17'] }),
      );
      expect(rule).toMatchObject({ _tag: 'UnsupportedForProviderError', provider: 'apple' });
      const guests = yield* Effect.flip(
        mutations.updateEvent({
          accountId: APPLE_CALENDAR_ACCOUNT_ID,
          calendarId: 'ek-home',
          changes: { attendees: [{ email: 'ana@example.com' }] },
          eventId: 'ek-single',
        }),
      );
      expect(guests).toMatchObject({ field: 'attendees' });
      const defaults = yield* Effect.flip(
        mutations.updateEvent({
          accountId: APPLE_CALENDAR_ACCOUNT_ID,
          calendarId: 'ek-home',
          changes: { reminders: { overrides: [], useDefault: true } },
          eventId: 'ek-single',
        }),
      );
      expect(defaults).toMatchObject({ field: 'reminders.useDefault', provider: 'apple' });
      const email = yield* Effect.flip(
        mutations.createEvent({
          ...base,
          reminders: { overrides: [{ method: 'email', minutes: 30 }], useDefault: false },
        }),
      );
      expect(email).toMatchObject({ field: 'reminders.email', provider: 'apple' });
      const rsvp = yield* Effect.flip(
        mutations.respondToEvent({
          accountId: APPLE_CALENDAR_ACCOUNT_ID,
          calendarId: 'ek-home',
          eventId: 'ek-single',
          response: 'accepted',
        }),
      );
      expect(rsvp).toMatchObject({ field: 'rsvp' });
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('maps each recurring scope onto its EventKit span', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const mutations = yield* EventMutations;
      const target = {
        accountId: APPLE_CALENDAR_ACCOUNT_ID,
        calendarId: 'ek-home',
        masterId: 'ek-series',
      };
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Standup (moved room)' },
        originalStartUtc: seriesStart + 7 * DAY,
        scope: 'instance',
      });
      expect(series(fake).map((entry) => entry.title)).toEqual([
        'Standup',
        'Standup (moved room)',
        'Standup',
        'Standup',
      ]);
      yield* mutations.updateRecurring({
        ...target,
        changes: { title: 'Standup v2' },
        originalStartUtc: seriesStart + 14 * DAY,
        scope: 'following',
      });
      expect(series(fake).map((entry) => entry.title)).toEqual([
        'Standup',
        'Standup (moved room)',
        'Standup v2',
        'Standup v2',
      ]);
      yield* mutations.deleteRecurring({
        ...target,
        originalStartUtc: seriesStart,
        scope: 'instance',
      });
      expect(series(fake)).toHaveLength(3);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('refuses to switch a series or an occurrence between timed and all-day', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const mutations = yield* EventMutations;
      for (const scope of ['instance', 'following', 'series'] as const) {
        const error = yield* Effect.flip(
          mutations.updateRecurring({
            accountId: APPLE_CALENDAR_ACCOUNT_ID,
            calendarId: 'ek-home',
            changes: { isAllDay: true, title: 'Standup' },
            masterId: 'ek-series',
            originalStartUtc: seriesStart + 7 * DAY,
            scope,
          }),
        );
        expect(error._tag).toBe('RecurringAllDaySwitchError');
      }
      expect(series(fake).every((entry) => !entry.isAllDay)).toBe(true);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('a series time edit on a later occurrence shifts the whole series by its delta', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const slot = seriesStart + 14 * DAY;
      yield* (yield* EventMutations).updateRecurring({
        accountId: APPLE_CALENDAR_ACCOUNT_ID,
        calendarId: 'ek-home',
        changes: { endUtc: slot + 2 * HOUR, startUtc: slot + HOUR },
        masterId: 'ek-series',
        originalStartUtc: slot,
        scope: 'series',
      });
      expect(series(fake).map((entry) => entry.startUtc - entry.occurrenceStartUtc!)).toEqual([
        0, 0, 0, 0,
      ]);
      expect(series(fake).map((entry) => entry.startUtc)).toEqual(
        [0, 1, 2, 3].map((week) => seriesStart + HOUR + week * 7 * DAY),
      );
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('recolors writable calendars and refuses read-only ones', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const mutations = yield* EventMutations;
      yield* mutations.setCalendarColor({
        accountId: APPLE_CALENDAR_ACCOUNT_ID,
        calendarId: 'ek-home',
        colorHex: '#FF2968',
      });
      expect(fake.state.calendars.get('ek-home')?.colorHex).toBe('#ff2968');
      const home = (yield* (yield* CalendarRepo).list(APPLE_CALENDAR_ACCOUNT_ID)).find(
        (entry) => entry.id === 'ek-home',
      );
      expect(home?.colorHex).toBe('#ff2968');
      const refused = yield* Effect.flip(
        mutations.setCalendarColor({
          accountId: APPLE_CALENDAR_ACCOUNT_ID,
          calendarId: 'ek-holidays',
          colorHex: '#ff2968',
        }),
      );
      expect(refused._tag).toBe('AppleCalendarRequestError');
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('deleting what EventKit already removed is done', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      fake.state.series.delete('ek-single');
      yield* (yield* EventMutations).deleteEvent({
        accountId: APPLE_CALENDAR_ACCOUNT_ID,
        calendarId: 'ek-home',
        eventId: 'ek-single',
      });
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect(
    'an occurrence moved further than 31 days from its slot is edited and deleted on its own',
    () => {
      const fake = fakeWith();
      return Effect.gen(function* () {
        yield* connected;
        const mutations = yield* EventMutations;
        const slot = seriesStart + 7 * DAY;
        // Forty days off its slot: further than the bridge looks for a slot.
        // EventKit knows it by an identifier of its own, at any distance.
        yield* mutations.updateRecurring({
          ...standup,
          changes: { endUtc: slot + 40 * DAY + HOUR, startUtc: slot + 40 * DAY },
          originalStartUtc: slot,
          scope: 'instance',
        });
        yield* mutations.updateRecurring({
          ...standup,
          changes: { title: 'Standup (far)' },
          originalStartUtc: slot,
          scope: 'instance',
        });
        expect(yield* occurrenceAt(slot)).toMatchObject({
          startUtc: slot + 40 * DAY,
          title: 'Standup (far)',
        });
        yield* mutations.deleteRecurring({ ...standup, originalStartUtc: slot, scope: 'instance' });
        expect(yield* occurrenceAt(slot)).toBeUndefined();
        expect(fake.state.series.get('ek-series')?.deleted.has(slot)).toBe(true);
        // "This and following" from one that sits far off cuts the series at its slot.
        const later = seriesStart + 14 * DAY;
        yield* mutations.updateRecurring({
          ...standup,
          changes: { endUtc: later - 50 * DAY + HOUR, startUtc: later - 50 * DAY },
          originalStartUtc: later,
          scope: 'instance',
        });
        yield* mutations.deleteRecurring({
          ...standup,
          originalStartUtc: later,
          scope: 'following',
        });
        expect(series(fake).map((entry) => entry.occurrenceStartUtc)).toEqual([seriesStart]);
      }).pipe(Effect.provide(testLayer(fake)));
    },
  );

  it.effect('a delete that cannot find its occurrence is refused, never counted as done', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const mutations = yield* EventMutations;
      const slot = seriesStart + 7 * DAY;
      yield* mutations.updateRecurring({
        ...standup,
        changes: { endUtc: slot + 40 * DAY + HOUR, startUtc: slot + 40 * DAY },
        originalStartUtc: slot,
        scope: 'instance',
      });
      // EventKit never rewrites the identifier it gave the occurrence: once
      // the series' time changed, it names a slot the series no longer has.
      // Forty days off, no read around the slot finds the occurrence either.
      const walk = fake.state.series.get('ek-series')!;
      walk.detached.set(slot, { ...walk.detached.get(slot)!, id: 'ek-series/RID=1' });
      expect(yield* occurrenceAt(slot)).toMatchObject({ startUtc: slot + 40 * DAY });
      for (const scope of ['instance', 'following'] as const) {
        const refused = yield* Effect.flip(
          mutations.deleteRecurring({ ...standup, originalStartUtc: slot, scope }),
        );
        expect(refused).toMatchObject({ _tag: 'EventNotFoundError', eventId: 'ek-series' });
      }
      // Refused before EventKit was asked to remove anything.
      expect(deletes(fake)).toBe(0);
      expect(yield* occurrenceAt(slot)).toBeDefined();
      const edit = yield* Effect.flip(
        mutations.updateRecurring({
          ...standup,
          changes: { title: 'x' },
          originalStartUtc: slot,
          scope: 'instance',
        }),
      );
      expect(edit).toMatchObject({ _tag: 'AppleCalendarRequestError' });
      // Within 31 days of its slot a read finds it, whatever its identifier says.
      walk.detached.set(slot, {
        ...walk.detached.get(slot)!,
        endUtc: slot + 20 * DAY + HOUR,
        startUtc: slot + 20 * DAY,
      });
      yield* mutations.deleteRecurring({ ...standup, originalStartUtc: slot, scope: 'instance' });
      expect(yield* occurrenceAt(slot)).toBeUndefined();
      // The series as a whole is named by its id alone and still goes.
      yield* mutations.deleteRecurring({ ...standup, originalStartUtc: slot, scope: 'series' });
      expect(fake.state.series.has('ek-series')).toBe(false);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect(
    'an occurrence deleted elsewhere is not found; one that goes mid-delete is done',
    () => {
      const fake = fakeWith();
      const slot = seriesStart + 7 * DAY;
      const elsewhere = fake.bridge.delete({
        ref: { id: 'ek-series', originalStartUtc: slot },
        span: 'thisEvent',
      });
      // Calendar.app removes the occurrence right after the read that found it.
      let racing = false;
      const raced: AppleCalendarClientShape = withSeriesIdentity({
        ...fake.bridge,
        events: (range) =>
          Effect.tap(fake.bridge.events(range), () => {
            const race = racing ? Effect.ignore(elsewhere) : Effect.void;
            racing = false;
            return race;
          }),
      });
      return Effect.gen(function* () {
        yield* connected;
        const mutations = yield* EventMutations;
        racing = true;
        yield* mutations.deleteRecurring({ ...standup, originalStartUtc: slot, scope: 'instance' });
        // Calendar.app's delete landed; ours found nothing left and is done.
        expect(deletes(fake)).toBe(2);
        expect(fake.state.series.get('ek-series')?.deleted.has(slot)).toBe(true);
        // Gone before the read: a miss cannot tell "deleted" from "out of
        // reach", so it is never answered with success.
        const gone = yield* Effect.flip(
          mutations.deleteRecurring({ ...standup, originalStartUtc: slot, scope: 'instance' }),
        );
        expect(gone).toMatchObject({ _tag: 'EventNotFoundError', eventId: 'ek-series' });
        expect(deletes(fake)).toBe(2);
      }).pipe(Effect.provide(testLayer({ ...fake, client: raced })));
    },
  );
});

/** The occurrence of the weekly series drawn at `slot`, as the views read it. */
const occurrenceAt = (slot: number) =>
  Effect.gen(function* () {
    const events = yield* (yield* AppleCalendarEvents).eventsInRange(
      seriesStart - 100 * DAY,
      seriesStart + 200 * DAY,
    );
    return events.find(
      (entry) => entry.recurringEventId !== undefined && entry.originalStartUtc === slot,
    );
  });

/** Moves one occurrence of the weekly series on its own. */
const moveBy = (slot: number, delta: number) =>
  Effect.gen(function* () {
    yield* (yield* EventMutations).updateRecurring({
      ...standup,
      changes: { endUtc: slot + delta + HOUR, startUtc: slot + delta },
      originalStartUtc: slot,
      scope: 'instance',
    });
  });

// EventKit gives an occurrence changed on its own an identifier of its own
// (`<series id>/RID=…`); the fake answers with it like the bridge does.
describe('Apple Calendar: an occurrence changed on its own', () => {
  it.effect('stays one occurrence of its series, under the same record id', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const slot = seriesStart + 7 * DAY;
      const before = yield* occurrenceAt(slot);
      yield* moveBy(slot, 2 * HOUR);
      const moved = yield* occurrenceAt(slot);
      expect(moved).toMatchObject({
        id: `ek-series__${slot}`,
        originalStartUtc: slot,
        recurringEventId: 'ek-series',
        startUtc: slot + 2 * HOUR,
      });
      expect(moved?.id).toBe(before?.id);
      // What EventKit itself calls it.
      expect(fake.state.series.get('ek-series')?.detached.get(slot)?.id).toMatch(
        /^ek-series\/RID=\d+$/u,
      );
      // A second edit finds it again by its series and slot.
      yield* (yield* EventMutations).updateRecurring({
        ...standup,
        changes: { title: 'Standup (late)' },
        originalStartUtc: slot,
        scope: 'instance',
      });
      expect(yield* occurrenceAt(slot)).toMatchObject({
        startUtc: slot + 2 * HOUR,
        title: 'Standup (late)',
      });
      expect(fake.state.series.size).toBe(4);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('"All events" from it writes and deletes the whole series', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const mutations = yield* EventMutations;
      const slot = seriesStart + 7 * DAY;
      yield* moveBy(slot, 2 * HOUR);
      // The editor names the series by what the occurrence it shows says.
      const shown = yield* occurrenceAt(slot);
      const fromShown = { ...standup, masterId: shown!.recurringEventId!, originalStartUtc: slot };
      yield* mutations.updateRecurring({
        ...fromShown,
        changes: { title: 'Standup (all)' },
        scope: 'series',
      });
      expect(series(fake).map((entry) => entry.title)).toEqual(
        Array.from({ length: 4 }, () => 'Standup (all)'),
      );
      // Still one series, the moved occurrence still moved.
      expect(fake.state.series.size).toBe(4);
      expect(yield* occurrenceAt(slot)).toMatchObject({ startUtc: slot + 2 * HOUR });
      yield* mutations.deleteRecurring({ ...fromShown, scope: 'series' });
      expect(fake.state.series.has('ek-series')).toBe(false);
      expect(series(fake)).toEqual([]);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('"All events" writes a series whose first occurrence was changed or deleted', () => {
    const changed = fakeWith();
    const deleted = fakeWith();
    const rename = Effect.gen(function* () {
      yield* (yield* EventMutations).updateRecurring({
        ...standup,
        changes: { title: 'Standup (all)' },
        originalStartUtc: seriesStart + 14 * DAY,
        scope: 'series',
      });
    });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* connected;
        yield* moveBy(seriesStart, 2 * HOUR);
        yield* rename;
        expect(series(changed).map((entry) => entry.title)).toEqual(
          Array.from({ length: 4 }, () => 'Standup (all)'),
        );
        expect(yield* occurrenceAt(seriesStart)).toMatchObject({
          startUtc: seriesStart + 2 * HOUR,
        });
      }).pipe(Effect.provide(testLayer(changed)));
      yield* Effect.gen(function* () {
        yield* connected;
        yield* (yield* EventMutations).deleteRecurring({
          ...standup,
          originalStartUtc: seriesStart,
          scope: 'instance',
        });
        yield* rename;
        expect(series(deleted).map((entry) => entry.title)).toEqual(
          Array.from({ length: 3 }, () => 'Standup (all)'),
        );
      }).pipe(Effect.provide(testLayer(deleted)));
    });
  });

  it.effect('"This and following" from it splits the series at its slot', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const mutations = yield* EventMutations;
      const slot = seriesStart + 14 * DAY;
      yield* moveBy(slot, 2 * HOUR);
      yield* mutations.updateRecurring({
        ...standup,
        changes: { title: 'Standup v2' },
        originalStartUtc: slot,
        scope: 'following',
      });
      // The earlier ones keep the series, the rest follow on their slots.
      expect(
        series(fake).map((entry) => [entry.title, entry.startUtc - entry.occurrenceStartUtc!]),
      ).toEqual([
        ['Standup', 0],
        ['Standup', 0],
        ['Standup v2', 2 * HOUR],
        ['Standup v2', 0],
      ]);
      const continued = yield* occurrenceAt(slot);
      expect(continued?.recurringEventId).not.toBe('ek-series');
      // Deleting from the moved one on takes the new series whole.
      yield* mutations.deleteRecurring({
        ...standup,
        masterId: continued!.recurringEventId!,
        originalStartUtc: slot,
        scope: 'following',
      });
      expect(series(fake).map((entry) => entry.occurrenceStartUtc)).toEqual([
        seriesStart,
        seriesStart + 7 * DAY,
      ]);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('"This and following" from a changed first occurrence is the whole series', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      yield* moveBy(seriesStart, 2 * HOUR);
      yield* (yield* EventMutations).updateRecurring({
        ...standup,
        changes: { title: 'Standup v2' },
        originalStartUtc: seriesStart,
        scope: 'following',
      });
      // EventKit writes the series in place: no second series, the first still moved.
      expect(fake.state.series.size).toBe(4);
      expect(
        series(fake).map((entry) => [entry.title, entry.startUtc - entry.occurrenceStartUtc!]),
      ).toEqual([
        ['Standup v2', 2 * HOUR],
        ['Standup v2', 0],
        ['Standup v2', 0],
        ['Standup v2', 0],
      ]);
    }).pipe(Effect.provide(testLayer(fake)));
  });

  it.effect('counts toward what a move to another account drops', () => {
    const fake = fakeWith();
    return Effect.gen(function* () {
      yield* connected;
      const mutations = yield* EventMutations;
      yield* moveBy(seriesStart + 7 * DAY, 2 * HOUR);
      yield* moveBy(seriesStart + 14 * DAY, 40 * DAY);
      const preview = yield* mutations.previewMove({
        accountId: APPLE_CALENDAR_ACCOUNT_ID,
        calendarId: 'ek-home',
        eventId: 'ek-series',
        target: { accountId: 'acc-google', calendarId: 'primary' },
      });
      expect(preview.modifiedOccurrences).toBe(2);
    }).pipe(Effect.provide(testLayer(fake)));
  });
});

const standups = (fake: ReturnType<typeof makeFakeAppleCalendarClient>) =>
  Effect.runSync(fake.client.events({ endUtc: window.end, startUtc: window.start })).filter(
    (entry) => entry.title === 'Standup',
  );

describe('Apple Calendar recurrence rule edits', () => {
  const target = {
    accountId: APPLE_CALENDAR_ACCOUNT_ID,
    calendarId: 'ek-home',
    masterId: 'ek-series',
  };

  it.effect(
    'a series takes a new rule, a later occurrence can end it, EventKit-only parts are refused',
    () => {
      const fake = fakeWith();
      return Effect.gen(function* () {
        yield* connected;
        const mutations = yield* EventMutations;
        expect(standups(fake)).toHaveLength(4);
        yield* mutations.updateRecurring({
          ...target,
          changes: { recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] },
          originalStartUtc: seriesStart + 7 * DAY,
          scope: 'series',
        });
        expect(standups(fake).map((entry) => entry.startUtc)).toEqual([
          seriesStart,
          seriesStart + DAY,
          seriesStart + 2 * DAY,
        ]);
        // "Does not repeat" from the second day on: the series ends before
        // it and the second day stays as a single event.
        yield* mutations.updateRecurring({
          ...target,
          changes: { recurrence: null },
          originalStartUtc: seriesStart + DAY,
          scope: 'following',
        });
        const left = standups(fake);
        expect(left.map((entry) => entry.startUtc)).toEqual([seriesStart, seriesStart + DAY]);
        expect(left[1]!.hasRecurrence).toBe(false);
        const refused = yield* Effect.flip(
          mutations.updateRecurring({
            ...target,
            changes: { recurrence: ['RRULE:FREQ=DAILY', 'EXDATE:20260704T090000Z'] },
            originalStartUtc: seriesStart,
            scope: 'series',
          }),
        );
        expect(refused).toMatchObject({ _tag: 'UnsupportedForProviderError', provider: 'apple' });
      }).pipe(Effect.provide(testLayer(fake)));
    },
  );
});
