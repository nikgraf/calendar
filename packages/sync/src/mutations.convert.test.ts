import { type FakeEventSeed, makeFakeAppleCalendarClient } from '@calendar/apple-calendar';
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
  googleInstanceId,
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
import { findAppleOccurrence } from './appleOccurrence.ts';
import { EventMutations } from './mutations.ts';

// Queue assertions run before the detached drain gets a turn.
const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
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
  moveTask: () => Effect.die('unexpected moveTask'),
  patchTask: () => Effect.die('unexpected patchTask'),
};

const APPLE_CAL = APPLE_CALENDAR_ACCOUNT_ID;
const APPLE_REM = APPLE_REMINDERS_ACCOUNT_ID;

const appleFake = (more: ReadonlyArray<FakeEventSeed> = []) =>
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
      ...more,
    ],
  });

/** A weekly Apple series from `base`, four occurrences. */
const appleSeries: FakeEventSeed = {
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
    title: 'Run',
    updatedAt: 1,
    url: 'https://example.com/route',
  },
  recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
};

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
    organizerEmail: 'nik@example.com',
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
  yield* accounts.upsert(account('acc-1', 'nik@example.com'));
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
          email: 'nik@example.com',
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
        new Attendee({ email: 'nik@example.com', isSelf: true, responseStatus: 'accepted' }),
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
  /** One occurrence of the series, by its slot; absent, the whole event. */
  originalStartUtc?: number,
) =>
  Effect.flatMap(EventMutations, (mutations) =>
    mutations.convertEventToTask({
      accountId,
      calendarId,
      draft,
      eventId,
      ...(originalStartUtc === undefined ? {} : { occurrence: { originalStartUtc } }),
      target: { accountId: targetAccountId, taskListId },
    }),
  );

/** The Google id of the occurrence `evt-series` draws `weeks` after its first. */
const standupSlot = (weeks: number) => base + weeks * WEEK;
const standupId = (weeks: number) => googleInstanceId('evt-series', standupSlot(weeks), false);

/** A subtask of `t1`: Google deletes it with its parent. */
const withSubtask = Effect.flatMap(TaskRepo, (repo) =>
  repo.upsertTasks(
    [
      new TaskRecord({
        accountId: 'acc-1',
        id: 'sub-1',
        listId: 'list-1',
        parentId: 't1',
        position: '00000000000000000000',
        provider: 'google',
        status: 'needsAction',
        title: 'Find the IBAN',
        updatedAt: 100,
      }),
    ],
    100,
  ),
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

  it.effect('one occurrence converts alone: the series skips its slot and keeps the rest', () => {
    const apple = appleFake();
    const reminders = remindersFake();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      // The third occurrence: generated from the rule, no row of its own.
      const slot = standupSlot(2);
      expect(
        yield* mutations.previewEventToTask({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          eventId: 'evt-series',
          occurrence: { originalStartUtc: slot },
          target: { accountId: APPLE_REM, taskListId: 'list-a' },
        }),
        // No rule to carry, and neither it nor the edited sibling is lost.
      ).toEqual({
        loss: {
          attendees: 0,
          dueTime: false,
          location: false,
          modifiedOccurrences: 0,
          recurrence: false,
          reminders: 0,
        },
      });
      const created = yield* toTask(
        ['acc-1', 'cal-1', 'evt-series'],
        [APPLE_REM, 'list-a'],
        { dueDate: day.add({ days: 14 }).toString(), dueTime: '09:00', title: 'Standup' },
        slot,
      );
      expect(reminders.state.reminders.get(created.id)).toMatchObject({
        dueDate: day.add({ days: 14 }).toString(),
        title: 'Standup',
      });
      expect((yield* eventAt('acc-1', 'cal-1', 'evt-series'))?.recurrence).toEqual([
        'RRULE:FREQ=WEEKLY;COUNT=4',
      ]);
      expect(yield* eventAt('acc-1', 'cal-1', 'evt-series_override')).not.toBeNull();
      expect(yield* eventAt('acc-1', 'cal-1', standupId(2))).toMatchObject({
        originalStartUtc: slot,
        recurringEventId: 'evt-series',
        status: 'cancelled',
        syncStatus: 'pending',
      });
      expect(yield* queued).toEqual([`delete acc-1/cal-1/${standupId(2)}`]);
    }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
  });

  it.effect(
    'an occurrence edited on its own is read from its row; Google → Google queues both writes',
    () => {
      const apple = appleFake();
      const reminders = remindersFake();
      return Effect.gen(function* () {
        yield* seed;
        const mutations = yield* EventMutations;
        const slot = standupSlot(3);
        yield* (yield* EventRepo).upsertMany([
          googleEvent({
            attendees: [
              new Attendee({
                email: 'nik@example.com',
                isOrganizer: true,
                isSelf: true,
                responseStatus: 'accepted',
              }),
              new Attendee({ email: 'bob@example.com', responseStatus: 'needsAction' }),
            ],
            etag: '"o1"',
            id: standupId(3),
            location: 'Room 9',
            originalStartUtc: slot,
            recurringEventId: 'evt-series',
            startUtc: slot + HOUR,
            title: 'Standup (retro)',
          }),
        ]);
        const source = {
          accountId: 'acc-1',
          calendarId: 'cal-1',
          eventId: 'evt-series',
          occurrence: { originalStartUtc: slot },
        };
        const target = { accountId: 'acc-1', taskListId: 'list-1' };
        // The master has neither a guest nor a room: the occurrence's own row decides.
        expect((yield* mutations.previewEventToTask({ ...source, target })).loss).toEqual({
          attendees: 1,
          dueTime: true,
          location: true,
          modifiedOccurrences: 0,
          recurrence: false,
          reminders: 0,
        });
        const created = yield* toTask(
          ['acc-1', 'cal-1', 'evt-series'],
          ['acc-1', 'list-1'],
          { dueDate: day.add({ days: 21 }).toString(), title: 'Standup (retro)' },
          slot,
        );
        expect(yield* eventAt('acc-1', 'cal-1', standupId(3))).toMatchObject({
          status: 'cancelled',
          title: 'Standup (retro)',
        });
        expect(yield* eventAt('acc-1', 'cal-1', 'evt-series')).not.toBeNull();
        const ops = yield* (yield* PendingOpRepo).listAll();
        expect(ops.map((op) => `${op.kind} ${op.eventId}`)).toEqual([
          `createTask ${created.id}`,
          `delete ${standupId(3)}`,
        ]);
        // The delete is the occurrence's own: Google's copy of it is what it must match.
        expect(ops[1]?.baseEtag).toBe('"o1"');
      }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
    },
  );

  it.effect('an occurrence that is not there, or not ours, is refused with nothing written', () => {
    const apple = appleFake();
    const reminders = remindersFake();
    return Effect.gen(function* () {
      yield* seed;
      yield* (yield* EventRepo).upsertMany([
        // Deleted on its own before: the series already skips this slot.
        googleEvent({
          id: standupId(2),
          originalStartUtc: standupSlot(2),
          recurringEventId: 'evt-series',
          startUtc: standupSlot(2),
          status: 'cancelled',
        }),
        googleEvent({
          attendees: [
            new Attendee({ email: 'nik@example.com', isSelf: true, responseStatus: 'accepted' }),
          ],
          id: 'evt-invite-series',
          organizerEmail: 'boss@example.com',
          recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
          title: 'Review',
        }),
      ]);
      const draft = { dueDate: day.toString(), title: 'Standup' };
      const refused = (eventId: string, originalStartUtc: number) =>
        Effect.map(
          Effect.flip(
            toTask(['acc-1', 'cal-1', eventId], [APPLE_REM, 'list-a'], draft, originalStartUtc),
          ),
          (error) => error._tag,
        );
      expect(yield* refused('evt-series', standupSlot(2))).toBe('EventNotFoundError');
      // Between two occurrences, and past the rule's last one.
      expect(yield* refused('evt-series', base + 3 * 24 * HOUR)).toBe('EventNotFoundError');
      expect(yield* refused('evt-series', standupSlot(4))).toBe('EventNotFoundError');
      // An event that does not repeat has no occurrence to name.
      expect(yield* refused('evt-a', base)).toBe('RecurringEditUnsupportedError');
      expect(yield* refused('evt-invite-series', base + WEEK)).toBe('NotOrganizerError');
      const preview = yield* Effect.flip(
        (yield* EventMutations).previewEventToTask({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          eventId: 'evt-series',
          occurrence: { originalStartUtc: standupSlot(2) },
          target: { accountId: APPLE_REM, taskListId: 'list-a' },
        }),
      );
      expect(preview._tag).toBe('EventNotFoundError');
      expect(reminders.state.reminders.size).toBe(1);
      expect(yield* queued).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
  });

  it.effect('one occurrence of an Apple series converts alone, found where it sits now', () => {
    const apple = appleFake([appleSeries]);
    const reminders = remindersFake();
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const slot = base + WEEK;
      // Moved three days off its slot and given a room, on its own.
      yield* apple.client.update({
        changes: {
          endUtc: slot + 3 * 24 * HOUR + HOUR,
          location: 'Track',
          startUtc: slot + 3 * 24 * HOUR,
        },
        ref: { id: 'ek-series', originalStartUtc: slot },
        span: 'thisEvent',
      });
      const source = {
        accountId: APPLE_CAL,
        calendarId: 'ek-home',
        eventId: 'ek-series',
        occurrence: { originalStartUtc: slot },
      };
      expect(
        yield* mutations.previewEventToTask({
          ...source,
          target: { accountId: 'acc-1', taskListId: 'list-1' },
        }),
      ).toEqual({
        carriedUrl: 'https://example.com/route',
        loss: {
          attendees: 0,
          dueTime: true,
          location: true,
          modifiedOccurrences: 0,
          recurrence: false,
          reminders: 0,
        },
      });
      const created = yield* toTask(
        [APPLE_CAL, 'ek-home', 'ek-series'],
        ['acc-1', 'list-1'],
        { dueDate: day.add({ days: 10 }).toString(), title: 'Run' },
        slot,
      );
      expect(created.provider).toBe('google');
      expect(yield* queued).toEqual([`createTask acc-1/list-1/${created.id}`]);
      const left = yield* apple.client.events({ endUtc: base + 5 * WEEK, startUtc: base - HOUR });
      expect(
        left.filter((event) => event.id === 'ek-series').map((event) => event.occurrenceStartUtc),
      ).toEqual([base, base + 2 * WEEK, base + 3 * WEEK]);
      // Gone from EventKit now: a second conversion finds no occurrence.
      const again = yield* Effect.flip(
        toTask(
          [APPLE_CAL, 'ek-home', 'ek-series'],
          [APPLE_REM, 'list-a'],
          { dueDate: day.toString(), title: 'Run' },
          slot,
        ),
      );
      expect(again._tag).toBe('EventNotFoundError');
      expect(reminders.state.reminders.size).toBe(1);
    }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
  });

  it.effect(
    'an Apple occurrence moved further than a delete by its slot reaches is refused, not copied',
    () => {
      const apple = appleFake([appleSeries]);
      const reminders = remindersFake();
      return Effect.gen(function* () {
        yield* seed;
        const slot = base + WEEK;
        // Forty days off its slot: the views still draw it, but the bridge
        // looks 31 days either side of a slot, and a delete that finds
        // nothing counts as done — the task would be a second copy.
        yield* apple.client.update({
          changes: { endUtc: slot + 40 * 24 * HOUR + HOUR, startUtc: slot + 40 * 24 * HOUR },
          ref: { id: 'ek-series', originalStartUtc: slot },
          span: 'thisEvent',
        });
        const asked: Array<{ readonly endUtc: number; readonly startUtc: number }> = [];
        const found = yield* findAppleOccurrence(
          {
            events: (range) => {
              asked.push(range);
              return apple.client.events(range);
            },
          },
          { id: 'ek-series', originalStartUtc: slot },
        );
        expect(found).toBeUndefined();
        expect(asked).toEqual([{ endUtc: slot + 31 * 24 * HOUR, startUtc: slot - 31 * 24 * HOUR }]);
        const refused = yield* Effect.flip(
          toTask(
            [APPLE_CAL, 'ek-home', 'ek-series'],
            [APPLE_REM, 'list-a'],
            { dueDate: day.toString(), title: 'Run' },
            slot,
          ),
        );
        expect(refused._tag).toBe('EventNotFoundError');
        expect(reminders.state.reminders.size).toBe(1);
        expect(apple.state.series.get('ek-series')?.detached.has(slot)).toBe(true);
      }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
    },
  );

  it.effect(
    'an Apple occurrence deleted elsewhere while it converts leaves a finished conversion',
    () => {
      const apple = appleFake([appleSeries]);
      const reminders = remindersFake();
      const slot = base + WEEK;
      // Calendar.app removes the occurrence right after the conversion read it.
      let reads = 0;
      const raced = {
        ...apple,
        client: {
          ...apple.client,
          events: (range: { readonly endUtc: number; readonly startUtc: number }) =>
            Effect.tap(apple.client.events(range), () => {
              reads += 1;
              return Effect.ignore(
                apple.client.delete({
                  ref: { id: 'ek-series', originalStartUtc: slot },
                  span: 'thisEvent',
                }),
              );
            }),
        },
      };
      return Effect.gen(function* () {
        yield* seed;
        // The task exists and the occurrence is gone: that is the conversion,
        // not a failure to report after the copy was made.
        const created = yield* toTask(
          [APPLE_CAL, 'ek-home', 'ek-series'],
          [APPLE_REM, 'list-a'],
          { dueDate: day.toString(), title: 'Run' },
          slot,
        );
        expect(created.title).toBe('Run');
        expect(reminders.state.reminders.size).toBe(2);
        expect(apple.state.series.get('ek-series')?.deleted.has(slot)).toBe(true);
        // One read decides the conversion; its delete does not look again.
        expect(reads).toBe(1);
      }).pipe(noYield, Effect.provide(testLayer(raced, reminders.client)));
    },
  );

  it.effect("a series converts as a whole; an occurrence's own id names no source", () => {
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

  it.effect('a Google parent task takes its subtasks with it, as Google would', () => {
    const apple = appleFake();
    const reminders = remindersFake();
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtask;
      const created = yield* toEvent(
        ['acc-1', 'list-1', 't1'],
        eventDraft('acc-1', 'cal-1', { title: 'Pay rent' }),
      );
      expect(yield* taskAt('acc-1', 'list-1', 't1')).toBeUndefined();
      expect(yield* taskAt('acc-1', 'list-1', 'sub-1')).toBeUndefined();
      expect(yield* queued).toEqual([
        `create acc-1/cal-1/${created.id}`,
        'deleteTask acc-1/list-1/sub-1',
        'deleteTask acc-1/list-1/t1',
      ]);
    }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
  });

  it.effect('the preview reads the stored task and counts the subtasks the delete takes', () => {
    const apple = appleFake();
    const reminders = remindersFake();
    return Effect.gen(function* () {
      yield* seed;
      yield* withSubtask;
      const mutations = yield* EventMutations;
      expect(
        yield* mutations.previewTaskToEvent({
          accountId: 'acc-1',
          taskId: 't1',
          taskListId: 'list-1',
        }),
      ).toEqual({
        alarmsAfterDue: 0,
        completed: false,
        priority: false,
        recurrence: false,
        subtasks: 1,
      });
      expect(
        yield* mutations.previewTaskToEvent({
          accountId: APPLE_REM,
          taskId: 'rem-timed',
          taskListId: 'list-a',
        }),
      ).toMatchObject({ priority: true, subtasks: 0 });
      const missing = yield* Effect.flip(
        mutations.previewTaskToEvent({ accountId: 'acc-1', taskId: 'ghost', taskListId: 'list-1' }),
      );
      expect(missing._tag).toBe('TaskNotFoundError');
      expect(yield* queued).toEqual([]);
    }).pipe(noYield, Effect.provide(testLayer(apple, reminders.client)));
  });

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
