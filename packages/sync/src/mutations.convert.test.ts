import { makeFakeAppleCalendarClient } from '@calendar/apple-calendar';
import {
  Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  APPLE_REMINDERS_ACCOUNT_ID,
  Attendee,
  CalendarInfo,
  type ConvertEventToTaskParams,
  type ConvertTaskToEventParams,
  EventRecord,
  EventReminders,
  plainDateToUtcMs,
  ReminderOverride,
  TaskListInfo,
  TaskRecord,
  Temporal,
} from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  PendingOpRepo,
  reposLayer,
  runMigrations,
  TaskRepo,
} from '@calendar/db';
import {
  type GcalEvent,
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GooglePeopleClient,
  GoogleTasksClient,
  type GoogleTasksClientShape,
} from '@calendar/google';
import {
  makeFakeRemindersClient,
  RemindersClient,
  type RemindersClientShape,
  RemindersRequestError,
} from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer, Scheduler } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { EventMutations } from './mutations.ts';

// Queue assertions run before the detached drain gets a turn.
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

const HOUR = 3_600_000;
// Date-independent: everything hangs off a UTC day a week from today.
const day = Temporal.Now.plainDateISO('UTC').add({ days: 7 });
const base = plainDateToUtcMs(day.toString()) + 9 * HOUR;

/** Nothing here is ever pushed: the drain never runs before the assertions. */
const inertGoogle: GoogleCalendarClientShape = {
  deleteEvent: () => Effect.die('unexpected deleteEvent'),
  getColors: () => Effect.succeed({ calendar: {} }),
  getEvent: () => Effect.die('unexpected get'),
  insertCalendar: () => Effect.die('not used'),
  insertEvent: ({ event }) =>
    Effect.succeed({ ...(event as GcalEvent), etag: '"new"', status: 'confirmed' as const }),
  listCalendars: () => Effect.succeed({ items: [] }),
  listEvents: () => Effect.succeed({ items: [] }),
  moveEvent: () => Effect.die('unexpected moveEvent'),
  patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
  patchEvent: () => Effect.die('unexpected patchEvent'),
  replaceEvent: () => Effect.die('not used'),
};

const inertTasks: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('unexpected deleteTask'),
  insertTask: () => Effect.die('unexpected insertTask'),
  listTaskLists: () => Effect.die('unexpected listTaskLists'),
  listTasks: () => Effect.die('unexpected listTasks'),
  patchTask: () => Effect.die('unexpected patchTask'),
};

const APPLE_CAL = APPLE_CALENDAR_ACCOUNT_ID;
const APPLE_REM = APPLE_REMINDERS_ACCOUNT_ID;

const appleFake = () =>
  makeFakeAppleCalendarClient({
    calendars: [
      {
        allowsModifications: true,
        id: 'ek-home',
        isDefault: true,
        sourceTitle: 'iCloud',
        sourceType: 'calDAV' as const,
        title: 'Home',
        type: 'calDAV' as const,
      },
    ],
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
          startUtc: base,
          status: 'confirmed',
          timeZone: 'UTC',
          title: 'Dentist',
          updatedAt: 1,
          url: 'https://example.com/agenda',
        },
      },
    ],
  });

const remindersFake = () =>
  makeFakeRemindersClient({
    lists: [{ allowsModifications: true, colorHex: '#ff0000', id: 'list-a', title: 'Errands' }],
    reminders: [
      {
        alarms: [-15],
        completed: false,
        dueDate: day.toString(),
        dueTime: '14:00',
        id: 'rem-timed',
        listId: 'list-a',
        priority: 1,
        title: 'Call mom',
        updatedAt: 10,
        url: 'https://example.com',
      },
    ],
  });

const testLayer = (
  apple: ReturnType<typeof makeFakeAppleCalendarClient>,
  reminders: RemindersClientShape,
) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(appleCalendarServicesLayer(apple.client)),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(GoogleCalendarClient, inertGoogle)),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, inertTasks)),
    Layer.provideMerge(
      Layer.succeed(GooglePeopleClient, {
        listConnections: () => Effect.die('not used'),
        listOtherContacts: () => Effect.die('not used'),
      }),
    ),
    Layer.provideMerge(Layer.succeed(RemindersClient, reminders)),
  );

const account = (id: string, email: string, provider: 'apple' | 'google' = 'google') =>
  new Account({
    contactsEnabled: false,
    createdAt: 1,
    email,
    id,
    provider,
    status: 'ok',
    tasksEnabled: true,
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
    startTimeZone: 'UTC',
    startUtc: base,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title: 'Planning',
    updatedAt: 1,
    ...overrides,
  });

const seed = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  yield* accounts.upsert(account('acc-1', 'nik@nikgraf.com'));
  yield* accounts.upsert(account(APPLE_CAL, '', 'apple'));
  yield* accounts.upsert(account(APPLE_REM, '', 'apple'));
  yield* (yield* CalendarRepo).upsertMany([
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-1',
      colorHex: '#3b82f6',
      defaultReminders: [new ReminderOverride({ method: 'popup', minutes: 30 })],
      id: 'cal-1',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'cal-1',
      timeZone: 'UTC',
    }),
    new CalendarInfo({
      accessRole: 'owner',
      accountId: APPLE_CAL,
      colorHex: '#1badf8',
      id: 'ek-home',
      isPrimary: true,
      isVisible: true,
      provider: 'apple',
      summary: 'Home',
      timeZone: 'UTC',
    }),
  ]);
  const tasks = yield* TaskRepo;
  yield* tasks.upsertLists(
    [
      new TaskListInfo({
        accountId: 'acc-1',
        id: 'list-1',
        isVisible: true,
        provider: 'google',
        title: 'My Tasks',
      }),
      new TaskListInfo({
        accountId: APPLE_REM,
        id: 'list-a',
        isVisible: true,
        provider: 'apple',
        title: 'Errands',
      }),
    ],
    100,
  );
  yield* tasks.upsertTasks(
    [
      new TaskRecord({
        accountId: 'acc-1',
        dueDate: day.toString(),
        id: 't1',
        listId: 'list-1',
        notes: 'transfer first',
        provider: 'google',
        status: 'needsAction',
        title: 'Pay rent',
        updatedAt: 100,
      }),
      new TaskRecord({
        accountId: APPLE_REM,
        alarms: [-15],
        dueDate: day.toString(),
        dueTime: '14:00',
        id: 'rem-timed',
        listId: 'list-a',
        priority: 'high',
        provider: 'apple',
        status: 'needsAction',
        title: 'Call mom',
        updatedAt: 100,
        url: 'https://example.com',
      }),
    ],
    100,
  );
  yield* (yield* EventRepo).upsertMany([
    googleEvent({
      attendees: [
        new Attendee({
          email: 'nik@nikgraf.com',
          isOrganizer: true,
          isSelf: true,
          responseStatus: 'accepted',
        }),
        new Attendee({ email: 'bob@example.com', responseStatus: 'needsAction' }),
      ],
      location: 'Room 4B',
      reminders: new EventReminders({
        overrides: [new ReminderOverride({ method: 'popup', minutes: 10 })],
        useDefault: false,
      }),
    }),
    googleEvent({ id: 'evt-series', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'], title: 'Standup' }),
    googleEvent({
      id: 'evt-series_override',
      originalStartUtc: base + 7 * 24 * HOUR,
      recurringEventId: 'evt-series',
      startUtc: base + 7 * 24 * HOUR + HOUR,
      title: 'Standup (moved)',
    }),
    googleEvent({
      attendees: [
        new Attendee({ email: 'nik@nikgraf.com', isSelf: true, responseStatus: 'accepted' }),
      ],
      id: 'evt-invite',
      organizerEmail: 'boss@example.com',
      title: 'Review',
    }),
  ]);
});

const eventAt = (accountId: string, calendarId: string, eventId: string) =>
  Effect.flatMap(EventRepo, (repo) => repo.getById(accountId, calendarId, eventId));
const taskAt = (accountId: string, listId: string, taskId: string) =>
  Effect.flatMap(TaskRepo, (repo) => repo.get(accountId, listId, taskId));
const queued = Effect.map(
  Effect.flatMap(PendingOpRepo, (ops) => ops.listAll()),
  (ops) => ops.map((op) => `${op.kind} ${op.accountId}/${op.calendarId}/${op.eventId}`),
);

const toTask = (
  [accountId, calendarId, eventId]: [string, string, string],
  [targetAccountId, taskListId]: [string, string],
  draft: ConvertEventToTaskParams['draft'],
) =>
  Effect.flatMap(EventMutations, (mutations) =>
    mutations.convertEventToTask({
      accountId,
      calendarId,
      draft,
      eventId,
      target: { accountId: targetAccountId, taskListId },
    }),
  );

const toEvent = (
  [accountId, taskListId, taskId]: [string, string, string],
  draft: ConvertTaskToEventParams['draft'],
) =>
  Effect.flatMap(EventMutations, (mutations) =>
    mutations.convertTaskToEvent({ accountId, draft, taskId, taskListId }),
  );

const eventDraft = (
  accountId: string,
  calendarId: string,
  overrides: Partial<ConvertTaskToEventParams['draft']> = {},
): ConvertTaskToEventParams['draft'] => ({
  accountId,
  calendarId,
  endUtc: base + 5 * HOUR + HOUR,
  isAllDay: false,
  startTimeZone: 'UTC',
  startUtc: base + 5 * HOUR,
  title: 'Call mom',
  ...overrides,
});

describe('convertEventToTask', () => {
  it.effect('Google event → Reminders writes the draft to EventKit and queues the delete', () => {
    const apple = appleFake();
    const reminders = remindersFake();
    return Effect.gen(function* () {
      yield* seed;
      const created = yield* toTask(['acc-1', 'cal-1', 'evt-a'], [APPLE_REM, 'list-a'], {
        alarms: [-10],
        dueDate: day.toString(),
        dueTime: '09:00',
        title: 'Planning',
      });
      expect(created).toMatchObject({
        accountId: APPLE_REM,
        alarms: [-10],
        dueTime: '09:00',
        listId: 'list-a',
        provider: 'apple',
        title: 'Planning',
      });
      expect(reminders.state.reminders.get(created.id)?.dueTime).toBe('09:00');
      expect(yield* eventAt('acc-1', 'cal-1', 'evt-a')).toBeNull();
      expect(yield* queued).toEqual(['delete acc-1/cal-1/evt-a']);
    }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
  });

  it.effect(
    'Google event → Google task queues both writes and refuses Reminders-only fields',
    () => {
      const apple = appleFake();
      const reminders = remindersFake();
      return Effect.gen(function* () {
        yield* seed;
        const refused = yield* Effect.flip(
          toTask(['acc-1', 'cal-1', 'evt-a'], ['acc-1', 'list-1'], {
            dueDate: day.toString(),
            dueTime: '09:00',
            title: 'Planning',
          }),
        );
        expect(refused._tag).toBe('UnsupportedForProviderError');
        expect(yield* eventAt('acc-1', 'cal-1', 'evt-a')).not.toBeNull();
        expect(yield* queued).toEqual([]);

        const created = yield* toTask(['acc-1', 'cal-1', 'evt-a'], ['acc-1', 'list-1'], {
          dueDate: day.toString(),
          notes: 'Room 4B',
          title: 'Planning',
        });
        expect(created).toMatchObject({ accountId: 'acc-1', listId: 'list-1', provider: 'google' });
        expect((yield* taskAt('acc-1', 'list-1', created.id))?.notes).toBe('Room 4B');
        expect(yield* eventAt('acc-1', 'cal-1', 'evt-a')).toBeNull();
        expect(yield* queued).toEqual([
          `createTask acc-1/list-1/${created.id}`,
          'delete acc-1/cal-1/evt-a',
        ]);
      }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
    },
  );

  it.effect(
    'Apple event → Google task queues the create, then removes the event from EventKit',
    () => {
      const apple = appleFake();
      const reminders = remindersFake();
      return Effect.gen(function* () {
        yield* seed;
        const created = yield* toTask([APPLE_CAL, 'ek-home', 'ek-single'], ['acc-1', 'list-1'], {
          dueDate: day.toString(),
          notes: 'Bring the forms\n\nhttps://example.com/agenda',
          title: 'Dentist',
        });
        expect(created.provider).toBe('google');
        expect(apple.state.series.has('ek-single')).toBe(false);
        expect(yield* queued).toEqual([`createTask acc-1/list-1/${created.id}`]);
      }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
    },
  );

  it.effect('the preview of an Apple event carries its URL, which the record does not show', () => {
    const apple = appleFake();
    const reminders = remindersFake();
    return Effect.gen(function* () {
      yield* seed;
      const preview = yield* (yield* EventMutations).previewEventToTask({
        accountId: APPLE_CAL,
        calendarId: 'ek-home',
        eventId: 'ek-single',
        target: { accountId: 'acc-1', taskListId: 'list-1' },
      });
      expect(preview.carriedUrl).toBe('https://example.com/agenda');
      expect(preview.loss.dueTime).toBe(true);
    }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
  });

  it.effect('a series converts as a whole; one occurrence cannot', () => {
    const apple = appleFake();
    const reminders = remindersFake();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const target = { accountId: APPLE_REM, taskListId: 'list-a' };
      expect(
        yield* mutations.previewEventToTask({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          eventId: 'evt-series',
          target,
        }),
      ).toEqual({
        carriedRecurrence: { count: 4, freq: 'weekly', interval: 1 },
        loss: {
          attendees: 0,
          dueTime: false,
          location: false,
          modifiedOccurrences: 1,
          recurrence: false,
          reminders: 0,
        },
      });
      const occurrence = yield* Effect.flip(
        toTask(['acc-1', 'cal-1', 'evt-series_override'], [APPLE_REM, 'list-a'], {
          dueDate: day.toString(),
          title: 'Standup',
        }),
      );
      expect(occurrence._tag).toBe('RecurringEditUnsupportedError');
      const created = yield* toTask(['acc-1', 'cal-1', 'evt-series'], [APPLE_REM, 'list-a'], {
        dueDate: day.toString(),
        dueTime: '09:00',
        recurrence: { count: 4, freq: 'weekly', interval: 1 },
        title: 'Standup',
      });
      expect(reminders.state.reminders.get(created.id)?.recurrence).toMatchObject({
        count: 4,
        freq: 'weekly',
      });
      expect(yield* eventAt('acc-1', 'cal-1', 'evt-series')).toBeNull();
      expect(yield* eventAt('acc-1', 'cal-1', 'evt-series_override')).toBeNull();
      expect(yield* queued).toEqual(['delete acc-1/cal-1/evt-series']);
    }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
  });

  it.effect('previews what the target cannot hold and refuses an invitation', () => {
    const apple = appleFake();
    const reminders = remindersFake();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const source = { accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-a' };
      expect(
        yield* mutations.previewEventToTask({
          ...source,
          target: { accountId: 'acc-1', taskListId: 'list-1' },
        }),
      ).toEqual({
        loss: {
          attendees: 1,
          dueTime: true,
          location: true,
          modifiedOccurrences: 0,
          recurrence: false,
          reminders: 1,
        },
      });
      expect(
        (yield* mutations.previewEventToTask({
          ...source,
          target: { accountId: APPLE_REM, taskListId: 'list-a' },
        })).loss.dueTime,
      ).toBe(false);
      const invite = yield* Effect.flip(
        toTask(['acc-1', 'cal-1', 'evt-invite'], [APPLE_REM, 'list-a'], {
          dueDate: day.toString(),
          title: 'Review',
        }),
      );
      expect(invite._tag).toBe('NotOrganizerError');
      expect(reminders.state.reminders.size).toBe(1);
      expect(yield* eventAt('acc-1', 'cal-1', 'evt-invite')).not.toBeNull();
      expect(yield* queued).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
  });
});

describe('convertTaskToEvent', () => {
  it.effect('Reminder → Google event queues the create and removes the reminder', () => {
    const apple = appleFake();
    const reminders = remindersFake();
    return Effect.gen(function* () {
      yield* seed;
      const created = yield* toEvent(
        [APPLE_REM, 'list-a', 'rem-timed'],
        eventDraft('acc-1', 'cal-1', { description: 'https://example.com' }),
      );
      expect(created).toMatchObject({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        description: 'https://example.com',
        title: 'Call mom',
      });
      expect((yield* eventAt('acc-1', 'cal-1', created.id))?.syncStatus).toBe('pending');
      expect(reminders.state.reminders.has('rem-timed')).toBe(false);
      expect(yield* taskAt(APPLE_REM, 'list-a', 'rem-timed')).toBeUndefined();
      expect(yield* queued).toEqual([`create acc-1/cal-1/${created.id}`]);
    }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
  });

  it.effect(
    'Google task → Apple event writes EventKit (URL included) and queues the task delete',
    () => {
      const apple = appleFake();
      const reminders = remindersFake();
      return Effect.gen(function* () {
        yield* seed;
        const created = yield* toEvent(
          ['acc-1', 'list-1', 't1'],
          eventDraft(APPLE_CAL, 'ek-home', { title: 'Pay rent', url: 'https://bank.example' }),
        );
        expect(created).toMatchObject({
          accountId: APPLE_CAL,
          calendarId: 'ek-home',
          title: 'Pay rent',
        });
        expect(apple.state.series.get(created.id)?.event.url).toBe('https://bank.example');
        expect(yield* taskAt('acc-1', 'list-1', 't1')).toBeUndefined();
        expect(yield* queued).toEqual(['deleteTask acc-1/list-1/t1']);
      }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
    },
  );

  it.effect('refuses a read-only or unknown calendar and a missing task, writing nothing', () => {
    const apple = appleFake();
    const reminders = remindersFake();
    return Effect.gen(function* () {
      yield* seed;
      const noCalendar = yield* Effect.flip(
        toEvent([APPLE_REM, 'list-a', 'rem-timed'], eventDraft('acc-1', 'nope')),
      );
      expect(noCalendar._tag).toBe('CalendarNotWritableError');
      const noTask = yield* Effect.flip(
        toEvent(['acc-1', 'list-1', 'ghost'], eventDraft('acc-1', 'cal-1')),
      );
      expect(noTask._tag).toBe('TaskNotFoundError');
      expect(reminders.state.reminders.has('rem-timed')).toBe(true);
      expect(yield* queued).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
  });

  it.effect('a delete that fails after the copy leaves a duplicate, never a lost task', () => {
    const apple = appleFake();
    const reminders = remindersFake();
    const failingDelete: RemindersClientShape = {
      ...reminders.client,
      delete: () =>
        Effect.fail(new RemindersRequestError({ message: 'EventKit refused', method: 'delete' })),
    };
    return Effect.gen(function* () {
      yield* seed;
      const error = yield* Effect.flip(
        toEvent([APPLE_REM, 'list-a', 'rem-timed'], eventDraft('acc-1', 'cal-1')),
      );
      expect(error._tag).toBe('RemindersRequestError');
      expect(yield* queued).toHaveLength(1);
      expect(reminders.state.reminders.has('rem-timed')).toBe(true);
      expect(yield* taskAt(APPLE_REM, 'list-a', 'rem-timed')).toBeDefined();
    }).pipe(noYield, Effect.provide(testLayer(apple, failingDelete)));
  });
});
