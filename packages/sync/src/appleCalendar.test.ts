import {
  type AppleCalendarJson,
  type AppleEventJson,
  makeFakeAppleCalendarClient,
} from '@calendar/apple-calendar';
import { Account, APPLE_CALENDAR_ACCOUNT_ID, plainDateToUtcMs, Temporal } from '@calendar/core';
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
import { layer as reactivityLayer, Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { AppleCalendarEvents, appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';

/** Google must never be called for the Apple Calendar account. */
const inertGoogle: GoogleCalendarClientShape = {
  deleteEvent: () => Effect.die('unexpected deleteEvent'),
  getColors: () => Effect.succeed({ calendar: {} }),
  insertEvent: () => Effect.die('unexpected insertEvent'),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  moveEvent: () => Effect.die('unexpected moveEvent'),
  patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
  patchEvent: () => Effect.die('unexpected patchEvent'),
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
  calendar({ id: 'ek-google-dup', isDefault: false, sourceTitle: 'NIK@nikgraf.com', title: 'Nik' }),
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
      email: 'nik@nikgraf.com',
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

describe('Apple Calendar mutations', () => {
  const series = (fake: ReturnType<typeof makeFakeAppleCalendarClient>) =>
    Effect.runSync(fake.client.events({ endUtc: window.end, startUtc: window.start })).filter(
      (entry) => entry.title.startsWith('Standup'),
    );

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
});
