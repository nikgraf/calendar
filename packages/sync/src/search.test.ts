import {
  type AppleCalendarJson,
  type AppleEventJson,
  makeFakeAppleCalendarClient,
} from '@calendar/apple-calendar';
import {
  Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  APPLE_REMINDERS_ACCOUNT_ID,
  CalendarInfo,
  EMPTY_SEARCH_RESULTS,
  EventRecord,
  encodeMirrorUrl,
  mirrorKeyHash,
  mirrorTag,
  type SearchResults,
  TaskListInfo,
  TaskRecord,
  Temporal,
} from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  reposLayer,
  runMigrations,
  TaskRepo,
} from '@calendar/db';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { TestClock } from 'effect/testing';
import { describe } from 'vite-plus/test';
import { type AppleCalendarEvents, appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { commonBackendHandlers } from './backendHandlers.ts';

const VIENNA = 'Europe/Vienna';
const HOUR = 3_600_000;

/** The instant a wall-clock time names in Vienna. */
const at = (wall: string): number =>
  Temporal.PlainDateTime.from(wall).toZonedDateTime(VIENNA).epochMilliseconds;

// A Saturday evening, the day before Vienna leaves summer time: the
// weekly series below cross the change.
const NOW = at('2026-10-24T18:00');

// The exported handler map widens each method to every backend service;
// search needs only these.
const search = (query: string) =>
  commonBackendHandlers.search({ query, timeZone: VIENNA }) as Effect.Effect<
    SearchResults,
    unknown,
    AppleCalendarEvents | EventRepo | TaskRepo
  >;

const account = (id: string, provider: 'apple' | 'google') =>
  new Account({
    contactsEnabled: false,
    createdAt: 1,
    email: provider === 'google' ? `${id}@example.com` : '',
    id,
    provider,
    status: 'ok',
    tasksEnabled: true,
  });

const calendar = (overrides: Partial<CalendarInfo>) =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId: 'acc',
    colorHex: '#4285f4',
    id: 'work',
    isPrimary: false,
    isVisible: true,
    provider: 'google',
    summary: 'Work',
    timeZone: VIENNA,
    ...overrides,
  });

const event = (id: string, start: number, overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'work',
    endUtc: start + HOUR,
    etag: null,
    id,
    isAllDay: false,
    startTimeZone: VIENNA,
    startUtc: start,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title: id,
    updatedAt: 1,
    ...overrides,
  });

const list = (overrides: Partial<TaskListInfo>) =>
  new TaskListInfo({
    accountId: 'acc',
    id: 'inbox',
    isVisible: true,
    provider: 'google',
    title: 'Inbox',
    ...overrides,
  });

const task = (id: string, overrides: Partial<TaskRecord> = {}) =>
  new TaskRecord({
    accountId: 'acc',
    id,
    listId: 'inbox',
    provider: 'google',
    status: 'needsAction',
    title: id,
    updatedAt: 1,
    ...overrides,
  });

const appleCalendar = (overrides: Partial<AppleCalendarJson>): AppleCalendarJson => ({
  allowsModifications: true,
  colorHex: '#34c759',
  id: 'ek-home',
  isDefault: true,
  sourceTitle: 'iCloud',
  sourceType: 'calDAV',
  title: 'Home',
  type: 'calDAV',
  ...overrides,
});

const appleEvent = (id: string, start: number, overrides: Partial<AppleEventJson> = {}) => ({
  calendarId: 'ek-home',
  endUtc: start + HOUR,
  hasRecurrence: false,
  id,
  isAllDay: false,
  isDetached: false,
  startUtc: start,
  status: 'confirmed' as const,
  timeZone: VIENNA,
  title: id,
  updatedAt: 1,
  ...overrides,
});

// Team lunch: weekly on Saturdays from three weeks back. Today's (noon)
// is over; next week's was cancelled on its own, so the series' next
// occurrence is the one after.
const TEAM_LUNCH_START = at('2026-10-03T12:00');
const CANCELLED_SLOT = at('2026-10-31T12:00');

const fake = () =>
  makeFakeAppleCalendarClient({
    calendars: [
      appleCalendar({}),
      appleCalendar({ id: 'ek-hidden', isDefault: false, title: 'Hidden' }),
    ],
    events: [
      { event: appleEvent('Lunch at the lake', at('2026-10-27T12:30')) },
      {
        event: appleEvent('ek-yoga', at('2026-10-05T07:00'), {
          hasRecurrence: true,
          occurrenceStartUtc: at('2026-10-05T07:00'),
          title: 'Yoga before lunch',
        }),
        recurrence: ['RRULE:FREQ=WEEKLY'],
      },
      {
        event: appleEvent('Lunch in a hidden calendar', at('2026-10-26T12:00'), {
          calendarId: 'ek-hidden',
        }),
      },
      {
        // A calendar mirror's copy carries its marker in the URL.
        event: appleEvent('Lunch copy', at('2026-10-27T12:30'), {
          url: encodeMirrorUrl({
            contentHash: '0123456789abcdef',
            keyHash: mirrorKeyHash('mirror-1', 'g|work|lunch'),
            rev: 1000,
            tag: mirrorTag('mirror-1'),
          }),
        }),
      },
    ],
  });

const seed = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  for (const entry of [
    account('acc', 'google'),
    account(APPLE_CALENDAR_ACCOUNT_ID, 'apple'),
    account(APPLE_REMINDERS_ACCOUNT_ID, 'apple'),
  ]) {
    yield* accounts.upsert(entry);
  }
  yield* (yield* CalendarRepo).upsertMany([
    calendar({}),
    calendar({ id: 'hidden', isVisible: false, summary: 'Hidden' }),
    calendar({ id: 'family', summary: 'Family (mirror destination)' }),
    calendar({
      accountId: APPLE_CALENDAR_ACCOUNT_ID,
      id: 'ek-home',
      provider: 'apple',
      summary: 'Home',
    }),
    calendar({
      accountId: APPLE_CALENDAR_ACCOUNT_ID,
      id: 'ek-hidden',
      isVisible: false,
      provider: 'apple',
      summary: 'Hidden',
    }),
  ]);
  yield* (yield* EventRepo).upsertMany([
    event('Lunch with Anna', at('2026-10-29T12:00'), { location: 'Café Central' }),
    event('Lunch with Ben', at('2026-09-14T12:00')),
    event('Lunch, called off', at('2026-10-28T12:00'), { status: 'cancelled' }),
    event('Lunch in a hidden calendar', at('2026-10-26T12:00'), { calendarId: 'hidden' }),
    event('Lunch with Anna (copy)', at('2026-10-29T12:00'), {
      calendarId: 'family',
      id: 'slnvmrcopy',
      mirror: 'tag.1.hash',
    }),
    event('team-lunch', TEAM_LUNCH_START, {
      recurrence: ['RRULE:FREQ=WEEKLY'],
      title: 'Team lunch',
    }),
    event('team-lunch_20261031T110000Z', CANCELLED_SLOT, {
      originalStartUtc: CANCELLED_SLOT,
      recurringEventId: 'team-lunch',
      status: 'cancelled',
      title: 'Team lunch',
    }),
    // A series that does not match, with one occurrence renamed on its own.
    event('standup', at('2026-10-05T09:00'), {
      recurrence: ['RRULE:FREQ=DAILY'],
      title: 'Standup',
    }),
    event('standup_20261027T080000Z', at('2026-10-27T11:30'), {
      originalStartUtc: at('2026-10-27T09:00'),
      recurringEventId: 'standup',
      title: 'Standup over lunch',
    }),
  ]);
  const tasks = yield* TaskRepo;
  yield* tasks.upsertLists(
    [
      list({}),
      list({ id: 'someday', isVisible: false, title: 'Someday' }),
      list({
        accountId: APPLE_REMINDERS_ACCOUNT_ID,
        id: 'ek-reminders',
        provider: 'apple',
        title: 'Reminders',
      }),
    ],
    1,
  );
  yield* tasks.upsertTasks(
    [
      task('Book a lunch table', { dueDate: '2026-10-26' }),
      task('Lunch someday', { listId: 'someday' }),
      task('Groceries', {
        accountId: APPLE_REMINDERS_ACCOUNT_ID,
        listId: 'ek-reminders',
        notes: 'Bread, and something for the lunch box',
        provider: 'apple',
      }),
      task('Lunch receipts', {
        accountId: APPLE_REMINDERS_ACCOUNT_ID,
        completedAt: at('2026-10-20T10:00'),
        listId: 'ek-reminders',
        provider: 'apple',
        status: 'completed',
      }),
    ],
    1,
  );
});

const testLayer = () =>
  appleCalendarServicesLayer(fake().client).pipe(
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

const titles = (group: SearchResults['upcoming']) => group.hits.map((hit) => hit.event.title);

describe('search handler', () => {
  it.effect('finds what the views show, one hit per series', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seed;
      const found = yield* search('lunch');

      expect(titles(found.upcoming)).toEqual([
        'Yoga before lunch',
        'Standup over lunch',
        'Lunch at the lake',
        'Lunch with Anna',
        'Team lunch',
      ]);
      expect(titles(found.past)).toEqual(['Lunch with Ben']);

      const byTitle = new Map(found.upcoming.hits.map((hit) => [hit.event.title, hit]));
      // The cancelled occurrence is skipped: the next one is a week later,
      // in winter time.
      expect(byTitle.get('Team lunch')).toMatchObject({
        event: { recurringEventId: 'team-lunch', startUtc: at('2026-11-07T12:00') },
        repeating: true,
      });
      // EventKit's series, read through: Monday's occurrence.
      expect(byTitle.get('Yoga before lunch')).toMatchObject({
        event: {
          accountId: APPLE_CALENDAR_ACCOUNT_ID,
          recurringEventId: 'ek-yoga',
          startUtc: at('2026-10-26T07:00'),
        },
        repeating: true,
      });
      // The one renamed occurrence of a series that does not match.
      expect(byTitle.get('Standup over lunch')).toMatchObject({
        event: { id: 'standup_20261027T080000Z', recurringEventId: 'standup' },
        repeating: true,
      });
      expect(byTitle.get('Lunch at the lake')?.repeating).toBe(false);
      expect(found.upcoming.total).toBe(5);

      expect(found.tasks.tasks.map((entry) => entry.title)).toEqual([
        'Book a lunch table',
        'Groceries',
        'Lunch receipts',
      ]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect('matches every word, across the fields, accents and case aside', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seed;
      expect(titles((yield* search('LUNCH cafe')).upcoming)).toEqual(['Lunch with Anna']);
      expect(titles((yield* search('anna ben')).upcoming)).toEqual([]);
      expect((yield* search('box')).tasks.tasks.map((entry) => entry.title)).toEqual(['Groceries']);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect('finds a series too frequent to expand over the whole window at once', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seed;
      yield* (yield* EventRepo).upsertMany([
        // Every hour since three weeks ago: tens of thousands of occurrences
        // over the search window, past the expander's iteration cap.
        event('hourly-ping', at('2026-10-03T00:30'), {
          endUtc: at('2026-10-03T00:45'),
          recurrence: ['RRULE:FREQ=HOURLY'],
          title: 'Hourly ping',
        }),
        // Hourly too, but over since last year: its latest occurrence stands for it.
        event('hourly-old', at('2025-01-01T00:30'), {
          endUtc: at('2025-01-01T00:45'),
          recurrence: ['RRULE:FREQ=HOURLY;UNTIL=20250601T000000Z'],
          title: 'Hourly backup',
        }),
      ]);
      const found = yield* search('hourly');
      expect(found.upcoming.hits).toHaveLength(1);
      expect(found.upcoming.hits[0]).toMatchObject({
        // 17:30 is over at 18:00; the next one is half past six.
        event: { recurringEventId: 'hourly-ping', startUtc: at('2026-10-24T18:30') },
        repeating: true,
      });
      expect(found.past.hits).toHaveLength(1);
      expect(found.past.hits[0]).toMatchObject({
        event: { recurringEventId: 'hourly-old', startUtc: Date.UTC(2025, 4, 31, 23, 30) },
        repeating: true,
      });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect('shows a series by its next matching occurrence, a renamed one on its own', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seed;
      // Mondays at ten; Monday's occurrence is renamed for an offsite.
      const renamedSlot = at('2026-10-26T10:00');
      yield* (yield* EventRepo).upsertMany([
        event('weekly-sync', at('2026-10-05T10:00'), {
          recurrence: ['RRULE:FREQ=WEEKLY'],
          title: 'Weekly sync',
        }),
        event('weekly-sync_20261026T090000Z', renamedSlot, {
          originalStartUtc: renamedSlot,
          recurringEventId: 'weekly-sync',
          title: 'Offsite',
        }),
      ]);
      expect((yield* search('weekly')).upcoming.hits).toMatchObject([
        { event: { startUtc: at('2026-11-02T10:00'), title: 'Weekly sync' }, repeating: true },
      ]);
      expect((yield* search('offsite')).upcoming.hits).toMatchObject([
        { event: { id: 'weekly-sync_20261026T090000Z', title: 'Offsite' }, repeating: true },
      ]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect('finds nothing for a blank query', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seed;
      expect(yield* search('   ')).toEqual(EMPTY_SEARCH_RESULTS);
    }).pipe(Effect.provide(testLayer())),
  );
});
