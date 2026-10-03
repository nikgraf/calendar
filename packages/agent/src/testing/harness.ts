import {
  type AppleCalendarJson,
  type AppleEventJson,
  type FakeEventSeed,
  makeFakeAppleCalendarClient,
  mapAppleCalendar,
} from '@calendar/apple-calendar';
import {
  Account,
  addDaysToPlainDate,
  APPLE_CALENDAR_ACCOUNT_ID,
  APPLE_REMINDERS_ACCOUNT_ID,
  Attendee,
  CalendarInfo,
  EventRecord,
  plainDateToUtcMs,
  TaskListInfo,
  TaskRecord,
  Temporal,
} from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  DeviceSettingsRepo,
  EventRepo,
  reposLayer,
  runMigrations,
  TaskRepo,
} from '@calendar/db';
import { GoogleCalendarClient, GoogleTasksClient } from '@calendar/google';
import {
  makeFakeRemindersClient,
  mapReminder,
  mapReminderList,
  type ReminderJson,
  RemindersClient,
} from '@calendar/reminders';
import { appleCalendarServicesLayer, DeviceContacts, EventMutations } from '@calendar/sync';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { type AgentPolicy, EMPTY_POLICY } from '../policy.ts';
import { encodeRef } from '../refs.ts';
import { AgentSignals } from '../signals.ts';
import { type AgentRecord, agentStoreLayer } from '../store.ts';

/**
 * One seeded world for the gateway tests: a Google account with four
 * calendars and a task list, the Apple Calendar fake with two calendars,
 * and the Reminders fake with two lists. Everything hangs off "two days
 * from today" so no assertion depends on the date the suite runs.
 */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

const today = Temporal.Now.plainDateISO('UTC');
export const baseDate = today.add({ days: 2 }).toString();
/** UTC midnight of the base day. */
export const base = plainDateToUtcMs(baseDate);
export const iso = (epochMs: number): string =>
  Temporal.Instant.fromEpochMilliseconds(epochMs).toString();

export const ACCOUNT = 'acc-1';
export const OWN_EMAIL = 'me@example.com';

const googleAccount = new Account({
  contactsEnabled: false,
  createdAt: 1,
  email: OWN_EMAIL,
  id: ACCOUNT,
  provider: 'google',
  status: 'ok',
  tasksEnabled: true,
});

const appleAccount = (id: string, displayName: string) =>
  new Account({
    contactsEnabled: false,
    createdAt: 1,
    displayName,
    email: '',
    id,
    provider: 'apple',
    status: 'ok',
    tasksEnabled: true,
  });

const googleCalendar = (
  id: string,
  summary: string,
  overrides: Partial<ConstructorParameters<typeof CalendarInfo>[0]> = {},
) =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId: ACCOUNT,
    colorHex: '#3b82f6',
    id,
    isPrimary: id === 'work',
    isVisible: true,
    provider: 'google',
    summary,
    timeZone: 'UTC',
    ...overrides,
  });

const googleEvent = (
  id: string,
  calendarId: string,
  title: string,
  startUtc: number,
  overrides: Partial<ConstructorParameters<typeof EventRecord>[0]> = {},
) =>
  new EventRecord({
    accountId: ACCOUNT,
    calendarId,
    endUtc: startUtc + HOUR,
    etag: '"1"',
    id,
    isAllDay: false,
    startTimeZone: 'UTC',
    startUtc,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
    ...overrides,
  });

const appleCalendar = (
  id: string,
  title: string,
  allowsModifications = true,
): AppleCalendarJson => ({
  allowsModifications,
  colorHex: '#1badf8',
  id,
  isDefault: id === 'ek-home',
  sourceTitle: 'iCloud',
  sourceType: 'calDAV',
  title,
  type: 'calDAV',
});

const appleEvent = (
  id: string,
  calendarId: string,
  title: string,
  startUtc: number,
): AppleEventJson => ({
  calendarId,
  endUtc: startUtc + HOUR,
  hasRecurrence: false,
  id,
  isAllDay: false,
  isDetached: false,
  startUtc,
  status: 'confirmed',
  timeZone: 'UTC',
  title,
  updatedAt: 1,
});

const reminder = (id: string, listId: string, title: string): ReminderJson => ({
  alarms: [],
  completed: false,
  dueDate: baseDate,
  id,
  listId,
  priority: 0,
  title,
  updatedAt: 10,
});

const APPLE_CALENDARS = [appleCalendar('ek-home', 'Home'), appleCalendar('ek-secret', 'Secret')];
const REMINDER_LISTS = [
  { allowsModifications: true, colorHex: '#ff0000', id: 'list-a', title: 'Reminders' },
  { allowsModifications: true, colorHex: '#00ff00', id: 'list-b', title: 'Private list' },
  { allowsModifications: false, colorHex: '#0000ff', id: 'list-ro', title: 'Shared read-only' },
];
const REMINDERS = [
  reminder('rem-a', 'list-a', 'Call mom'),
  reminder('rem-b', 'list-b', 'Private errand'),
];

/** Refs the tests address things by — exactly what an agent would have been handed. */
export const refs = {
  appleHome: encodeRef({
    accountId: APPLE_CALENDAR_ACCOUNT_ID,
    calendarId: 'ek-home',
    kind: 'calendar',
  }),
  calendar: (calendarId: string) => encodeRef({ accountId: ACCOUNT, calendarId, kind: 'calendar' }),
  event: (calendarId: string, eventId: string, accountId: string = ACCOUNT) =>
    encodeRef({ accountId, calendarId, eventId, kind: 'event' }),
  googleList: encodeRef({ accountId: ACCOUNT, kind: 'taskList', taskListId: 'tl-1' }),
  occurrence: (
    calendarId: string,
    masterId: string,
    originalStartUtc: number,
    accountId: string = ACCOUNT,
  ) => encodeRef({ accountId, calendarId, kind: 'occurrence', masterId, originalStartUtc }),
  reminderList: (taskListId: string) =>
    encodeRef({ accountId: APPLE_REMINDERS_ACCOUNT_ID, kind: 'taskList', taskListId }),
  task: (taskListId: string, taskId: string, accountId: string = APPLE_REMINDERS_ACCOUNT_ID) =>
    encodeRef({ accountId, kind: 'task', taskId, taskListId }),
};

/** Start of the weekly series: a week before the base day, 15:00 UTC. */
export const seriesStart = base - 7 * DAY + 15 * HOUR;

const seed = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  yield* accounts.upsert(googleAccount);
  yield* accounts.upsert(appleAccount(APPLE_CALENDAR_ACCOUNT_ID, 'Apple Calendar'));
  yield* accounts.upsert(appleAccount(APPLE_REMINDERS_ACCOUNT_ID, 'Apple Reminders'));

  yield* (yield* CalendarRepo).upsertMany([
    googleCalendar('work', 'Work'),
    googleCalendar('private', 'Private'),
    googleCalendar('team', 'Team (read-only)', { accessRole: 'reader' }),
    googleCalendar('hidden', 'Hidden', { isVisible: false }),
    ...APPLE_CALENDARS.map((calendar) => mapAppleCalendar(calendar, { deviceTimeZone: 'UTC' })),
  ]);
  // upsertMany keeps is_visible on update only; a fresh row takes it from the record.
  yield* (yield* CalendarRepo).setVisible(ACCOUNT, 'hidden', false);

  yield* (yield* EventRepo).upsertMany([
    googleEvent('standup', 'work', 'Standup', base + 10 * HOUR),
    googleEvent('lunch', 'work', 'Lunch with Ana', base + 12 * HOUR, {
      attendees: [
        new Attendee({
          email: OWN_EMAIL,
          isOrganizer: true,
          isSelf: true,
          responseStatus: 'accepted',
        }),
        new Attendee({ email: 'ana@example.com', responseStatus: 'accepted' }),
      ],
      organizerEmail: OWN_EMAIL,
    }),
    googleEvent('declined', 'work', 'Vendor pitch', base + 16 * HOUR, {
      attendees: [
        new Attendee({ email: OWN_EMAIL, isSelf: true, responseStatus: 'declined' }),
        new Attendee({
          email: 'vendor@example.com',
          isOrganizer: true,
          responseStatus: 'accepted',
        }),
      ],
      organizerEmail: 'vendor@example.com',
    }),
    googleEvent('weekly', 'work', 'Weekly sync', seriesStart, {
      recurrence: ['RRULE:FREQ=WEEKLY'],
    }),
    // An all-day weekly series, first on the day after the base day.
    googleEvent('review', 'work', 'Quarterly review day', base + DAY, {
      endDate: addDaysToPlainDate(baseDate, 2),
      endUtc: base + 2 * DAY,
      isAllDay: true,
      recurrence: ['RRULE:FREQ=WEEKLY'],
      startDate: addDaysToPlainDate(baseDate, 1),
      startTimeZone: undefined,
    }),
    googleEvent('therapy', 'private', 'Therapy', base + 10.5 * HOUR),
    googleEvent('offsite', 'team', 'Team offsite', base + 14 * HOUR),
    googleEvent('ghost', 'hidden', 'Hidden thing', base + 9 * HOUR),
  ]);

  const tasks = yield* TaskRepo;
  yield* tasks.upsertLists(
    [
      new TaskListInfo({
        accountId: ACCOUNT,
        id: 'tl-1',
        isVisible: true,
        provider: 'google',
        title: 'My Tasks',
      }),
      ...REMINDER_LISTS.map((list) => mapReminderList(list, APPLE_REMINDERS_ACCOUNT_ID)),
    ],
    1,
  );
  yield* tasks.upsertTasks(
    [
      new TaskRecord({
        accountId: ACCOUNT,
        dueDate: baseDate,
        id: 'gtask-1',
        listId: 'tl-1',
        provider: 'google',
        status: 'needsAction',
        title: 'File expenses',
        updatedAt: 1,
      }),
      ...REMINDERS.map((item) => mapReminder(item, APPLE_REMINDERS_ACCOUNT_ID)),
    ],
    1,
  );
  // A fixed primary zone keeps every formatted time independent of the machine.
  yield* (yield* DeviceSettingsRepo).set('timeZones', { primary: 'UTC', zones: ['UTC'] });
});

// Queued Google writes never land: the tests assert the local row and the queue.
const never = () => Effect.never;

/** Start of the Apple daily series some tests add: the base day, 20:00 UTC. */
export const appleSeriesStart = base + 20 * HOUR;

/** A daily Apple series ("Evening walk", an hour at 20:00) for tests of occurrences. */
export const appleDailySeries: FakeEventSeed = {
  event: {
    ...appleEvent('ek-walk', 'ek-home', 'Evening walk', appleSeriesStart),
    hasRecurrence: true,
    occurrenceStartUtc: appleSeriesStart,
  },
  recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
};

export const makeWorld = (
  options: { readonly appleEvents?: ReadonlyArray<FakeEventSeed> } = {},
) => {
  const apple = makeFakeAppleCalendarClient({
    calendars: APPLE_CALENDARS,
    events: [
      { event: appleEvent('ek-dentist', 'ek-home', 'Dentist', base + 8 * HOUR) },
      { event: appleEvent('ek-plan', 'ek-secret', 'Secret plan', base + 9 * HOUR) },
      ...(options.appleEvents ?? []),
    ],
  });
  const reminders = makeFakeRemindersClient({ lists: REMINDER_LISTS, reminders: REMINDERS });

  const backend = EventMutations.layer.pipe(
    Layer.provideMerge(appleCalendarServicesLayer(apple.client)),
    Layer.provideMerge(
      Layer.succeed(DeviceContacts, {
        birthdays: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
        refresh: () => Effect.void,
      }),
    ),
    Layer.provideMerge(Layer.effectDiscard(seed)),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, reminders.client)),
    Layer.provideMerge(
      Layer.succeed(GoogleCalendarClient, {
        deleteEvent: never,
        getColors: () => Effect.succeed({ calendar: {} }),
        getEvent: never,
        insertCalendar: never,
        insertEvent: never,
        listCalendars: () => Effect.succeed({ items: [] }),
        listEvents: () => Effect.succeed({ items: [] }),
        moveEvent: never,
        patchCalendarListEntry: never,
        patchEvent: never,
        replaceEvent: never,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(GoogleTasksClient, {
        deleteTask: never,
        insertTask: never,
        listTaskLists: never,
        listTasks: never,
        patchTask: never,
      }),
    ),
  );
  // The agent store has its own database, exactly as on the desktop.
  const agents = Layer.mergeAll(
    agentStoreLayer.pipe(Layer.provide(SqliteClient.layer({ filename: ':memory:' }))),
    AgentSignals.layer,
  );
  return { apple, layer: Layer.mergeAll(backend, agents), reminders };
};

let nextAgent = 0;

/** An agent record as `authenticate` would return it (no row needed for most gateway calls). */
export const agentWith = (policy: Partial<AgentPolicy>, name = 'Test agent'): AgentRecord => {
  nextAgent += 1;
  return {
    createdAt: 1,
    id: `agent-${nextAgent}`,
    name,
    policy: { ...EMPTY_POLICY, ...policy },
  };
};

export const grantCalendar = (
  calendarId: string,
  level: AgentPolicy['calendars'][number]['level'],
  accountId: string = ACCOUNT,
) => ({ accountId, calendarId, level });

export const grantList = (
  taskListId: string,
  level: AgentPolicy['taskLists'][number]['level'],
  accountId: string = APPLE_REMINDERS_ACCOUNT_ID,
) => ({ accountId, level, taskListId });
