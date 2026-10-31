import {
  type AppleEventJson,
  makeFakeAppleCalendarClient,
  unavailableAppleCalendarClient,
} from '@calendar/apple-calendar';
import { ContactsClient, makeFakeContactsClient } from '@calendar/contacts';
import {
  Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  APPLE_REMINDERS_ACCOUNT_ID,
  CalendarInfo,
  eventNotificationTarget,
  EventRecord,
  EventReminders,
  type PlannedNotification,
  ReminderOverride,
  TaskListInfo,
  taskNotificationTarget,
  TaskRecord,
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
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Deferred, Duration, Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { backgroundRefresh } from './backgroundRefresh.ts';
import { DeviceContacts } from './deviceContacts.ts';
import { SyncEngine } from './engine.ts';
import {
  writeBirthdayReminderOverrides,
  writeBirthdayReminderSettings,
  writeEventNotificationSettings,
  writeTaskNotificationSettings,
  writeTimeZoneSettings,
} from './deviceSettings.ts';
import { LocalNotifications } from './localNotifications.ts';
import { Mirrors } from './mirrors.ts';
import {
  type DeliveredNotification,
  NotificationSink,
  type NotificationSinkShape,
} from './notificationSink.ts';

const alice = { contactId: 'a', day: 4, displayName: 'Alice', month: 3, year: 1994 };

const immediateSink = () => {
  const shown: Array<string> = [];
  let asked = 0;
  const sink: NotificationSinkShape = {
    ensurePermission: () =>
      Effect.sync(() => {
        asked += 1;
        return true;
      }),
    kind: 'immediate',
    show: (planned) => Effect.sync(() => void shown.push(planned.key)),
  };
  return { asked: () => asked, shown, sink };
};

const scheduledSink = (
  granted = true,
  onReplace: (planned: ReadonlyArray<PlannedNotification>) => Effect.Effect<void, unknown> = () =>
    Effect.void,
  onDismiss: () => Effect.Effect<void, unknown> = () => Effect.void,
) => {
  const schedules: Array<ReadonlyArray<PlannedNotification>> = [];
  /** What the OS still shows; a test seeds it as delivered. A dismissed one leaves, as there. */
  const presented: Array<DeliveredNotification> = [];
  /** The keys the scheduler had dismissed, in order, across passes. */
  const dismissed: Array<string> = [];
  /** Every call to the OS in order, as it was asked. */
  const calls: Array<'dismiss' | 'replace'> = [];
  let asked = 0;
  const sink: NotificationSinkShape = {
    dismissDelivered: (shouldDismiss) => {
      calls.push('dismiss');
      return Effect.andThen(onDismiss(), () =>
        Effect.gen(function* () {
          const gone = new Set<string>();
          for (const delivered of presented) {
            if (yield* shouldDismiss(delivered)) {
              gone.add(delivered.key);
              dismissed.push(delivered.key);
            }
          }
          presented.splice(0, presented.length, ...presented.filter((d) => !gone.has(d.key)));
        }),
      );
    },
    ensurePermission: () =>
      Effect.sync(() => {
        asked += 1;
        return granted;
      }),
    kind: 'scheduled',
    replaceSchedule: (planned) => {
      calls.push('replace');
      return Effect.andThen(onReplace(planned), () =>
        Effect.sync(() => void schedules.push(planned)),
      );
    },
  };
  return { asked: () => asked, calls, dismissed, presented, schedules, sink };
};

const testLayer = (
  sink: NotificationSinkShape,
  apple = unavailableAppleCalendarClient('test'),
  timeZone: () => string = () => 'UTC',
) =>
  LocalNotifications.layer({ timeZone }).pipe(
    Layer.provideMerge(appleCalendarServicesLayer(apple)),
    Layer.provideMerge(DeviceContacts.layer),
    Layer.provideMerge(
      Layer.succeed(ContactsClient, makeFakeContactsClient({ birthdays: [alice] }).client),
    ),
    Layer.provideMerge(Layer.succeed(NotificationSink, sink)),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

/** The test clock starts at the epoch; move it to an instant. */
const setClock = (iso: string) => TestClock.adjust(Duration.millis(Date.parse(iso)));

const enableBirthdays = writeBirthdayReminderSettings({
  enabled: true,
  reminders: [
    { leadDays: 0, time: '09:00' },
    { leadDays: 1, time: '09:00' },
  ],
});

const popup = (minutes: number) => new ReminderOverride({ method: 'popup', minutes });

const standup = new EventRecord({
  accountId: 'acc-1',
  calendarId: 'cal-1',
  endUtc: Date.parse('2026-03-03T10:00:00Z'),
  etag: null,
  id: 'standup',
  isAllDay: false,
  reminders: new EventReminders({ overrides: [popup(10)], useDefault: false }),
  startTimeZone: 'UTC',
  startUtc: Date.parse('2026-03-03T09:00:00Z'),
  status: 'confirmed',
  syncedAt: 0,
  syncStatus: 'synced',
  title: 'Standup',
  updatedAt: 0,
});
const STANDUP_KEY = `event:acc-1/cal-1/standup:${String(standup.startUtc)}:10`;

/** The standup's reminder as the OS shows it after delivery, with the deadline its payload carried. */
const deliveredStandup = (dismissAt = standup.endUtc): DeliveredNotification => ({
  dismissAt,
  key: STANDUP_KEY,
  target: eventNotificationTarget(standup),
});

const seedGoogle = (...events: ReadonlyArray<EventRecord>) =>
  Effect.gen(function* () {
    yield* (yield* AccountRepo).upsert(
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
    yield* (yield* CalendarRepo).upsertMany([
      new CalendarInfo({
        accessRole: 'owner',
        accountId: 'acc-1',
        colorHex: '#3b82f6',
        defaultReminders: [popup(30)],
        id: 'cal-1',
        isPrimary: true,
        isVisible: true,
        provider: 'google',
        summary: 'Work',
        timeZone: 'UTC',
      }),
    ]);
    yield* (yield* EventRepo).upsertMany(events);
  });

const inbox = new TaskListInfo({
  accountId: 'acc-1',
  id: 'inbox',
  isVisible: true,
  provider: 'google',
  title: 'Inbox',
});
const errands = new TaskListInfo({
  accountId: APPLE_REMINDERS_ACCOUNT_ID,
  id: 'ek-errands',
  isVisible: true,
  provider: 'apple',
  title: 'Errands',
});
const home = new TaskListInfo({
  accountId: 'acc-1',
  id: 'home',
  isVisible: true,
  provider: 'google',
  title: 'Home',
});
const rent = new TaskRecord({
  accountId: 'acc-1',
  dueDate: '2026-03-03',
  id: 'rent',
  listId: 'inbox',
  provider: 'google',
  status: 'needsAction',
  title: 'Pay rent',
  updatedAt: 0,
});
const RENT_KEY = 'task:acc-1/rent:2026-03-03';
const callBank = new TaskRecord({
  accountId: APPLE_REMINDERS_ACCOUNT_ID,
  dueDate: '2026-03-03',
  dueTime: '14:00',
  dueUtc: Date.parse('2026-03-03T14:00:00Z'),
  id: 'bank',
  listId: 'ek-errands',
  provider: 'apple',
  status: 'needsAction',
  title: 'Call the bank',
  updatedAt: 0,
});
const BANK_KEY = `task:${APPLE_REMINDERS_ACCOUNT_ID}/bank:2026-03-03`;

/** A task's reminder as the OS shows it after delivery: its key and target, no deadline. */
const deliveredTask = (task: TaskRecord, key: string): DeliveredNotification => ({
  key,
  target: taskNotificationTarget(task, task.dueDate ?? ''),
});

/** The Google account of `seedGoogle` plus the Reminders one, a visible list each, and `tasks`. */
const seedTasks = (...tasks: ReadonlyArray<TaskRecord>) =>
  Effect.gen(function* () {
    yield* seedGoogle();
    yield* (yield* AccountRepo).upsert(
      new Account({
        contactsEnabled: false,
        createdAt: 1,
        email: '',
        id: APPLE_REMINDERS_ACCOUNT_ID,
        provider: 'apple',
        status: 'ok',
        tasksEnabled: true,
      }),
    );
    const taskRepo = yield* TaskRepo;
    yield* taskRepo.upsertLists([inbox, errands], 1);
    yield* taskRepo.upsertTasks(tasks, 1);
  });

const done = (task: TaskRecord) =>
  Effect.flatMap(TaskRepo, (repo) =>
    repo.setStatus({
      accountId: task.accountId,
      completedAt: Date.parse('2026-03-03T15:00:00Z'),
      listId: task.listId,
      status: 'completed',
      taskId: task.id,
    }),
  );

describe('LocalNotifications', () => {
  it.effect('an immediate sink fires each due birthday once, across runs', () => {
    const { shown, sink } = immediateSink();
    return Effect.gen(function* () {
      yield* enableBirthdays;
      const notifications = yield* LocalNotifications;
      yield* setClock('2026-03-03T10:00:00Z');
      yield* notifications.run();
      yield* notifications.run();
      expect(shown).toEqual(['birthday:device:a:2026-03-04:1']);
      yield* TestClock.adjust('24 hours');
      yield* notifications.run();
      expect(shown).toEqual(['birthday:device:a:2026-03-04:1', 'birthday:device:a:2026-03-04:0']);
    }).pipe(Effect.provide(testLayer(sink)));
  });

  it.effect("a person's own lead days replace the general ones", () => {
    const { shown, sink } = immediateSink();
    return Effect.gen(function* () {
      yield* writeBirthdayReminderSettings({
        enabled: true,
        reminders: [{ leadDays: 0, time: '09:00' }],
      });
      yield* writeBirthdayReminderOverrides([
        { day: 4, displayName: 'Alice', month: 3, reminders: [{ leadDays: 1, time: '09:00' }] },
      ]);
      const notifications = yield* LocalNotifications;
      yield* setClock('2026-03-03T10:00:00Z');
      yield* notifications.run();
      yield* TestClock.adjust('24 hours');
      yield* notifications.run();
      expect(shown).toEqual(['birthday:device:a:2026-03-04:1']);
    }).pipe(Effect.provide(testLayer(sink)));
  });

  it.effect('a muted person leaves the OS schedule', () => {
    const scheduled = scheduledSink();
    return Effect.gen(function* () {
      yield* enableBirthdays;
      const notifications = yield* LocalNotifications;
      yield* setClock('2026-03-01T12:00:00Z');
      yield* notifications.run();
      expect(scheduled.schedules.at(-1)?.map((plan) => plan.key)).toEqual([
        'birthday:device:a:2026-03-04:1',
        'birthday:device:a:2026-03-04:0',
      ]);
      yield* writeBirthdayReminderOverrides([
        { day: 4, displayName: 'Alice', month: 3, reminders: [] },
      ]);
      yield* notifications.run();
      expect(scheduled.schedules.at(-1)).toEqual([]);
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });

  it.effect('an immediate sink is asked for permission once, on the first pass', () => {
    const { asked, sink } = immediateSink();
    return Effect.gen(function* () {
      const notifications = yield* LocalNotifications;
      yield* setClock('2026-03-01T12:00:00Z');
      // Event notifications are on by default: nothing else needs enabling.
      yield* notifications.run();
      yield* notifications.run();
      expect(asked()).toBe(1);
      expect(yield* (yield* DeviceSettingsRepo).get('localNotifications.permissionAsked')).toBe(
        true,
      );
    }).pipe(Effect.provide(testLayer(sink)));
  });

  it.effect('does not prompt while every producer is off', () => {
    const { asked, sink } = immediateSink();
    return Effect.gen(function* () {
      yield* writeEventNotificationSettings({ enabled: false, includeAppleCalendar: false });
      yield* writeTaskNotificationSettings({
        enabled: false,
        includeAppleReminders: true,
        time: '09:00',
      });
      yield* (yield* LocalNotifications).run();
      expect(asked()).toBe(0);
    }).pipe(Effect.provide(testLayer(sink)));
  });

  it.effect('prompts for task notifications on their own', () => {
    const { asked, sink } = immediateSink();
    return Effect.gen(function* () {
      yield* writeEventNotificationSettings({ enabled: false, includeAppleCalendar: false });
      yield* (yield* LocalNotifications).run();
      expect(asked()).toBe(1);
    }).pipe(Effect.provide(testLayer(sink)));
  });

  it.effect('catches up on a birthday from the last day, not older ones', () => {
    const { shown, sink } = immediateSink();
    return Effect.gen(function* () {
      yield* enableBirthdays;
      const notifications = yield* LocalNotifications;
      // 09:00 on the 4th is 2 h old (fires); 09:00 on the 3rd is 26 h old (dropped).
      yield* setClock('2026-03-04T11:00:00Z');
      yield* notifications.run();
      expect(shown).toEqual(['birthday:device:a:2026-03-04:0']);
    }).pipe(Effect.provide(testLayer(sink)));
  });

  it.effect('an event reminder fires before the start and is dropped once the event began', () => {
    const { shown, sink } = immediateSink();
    return Effect.gen(function* () {
      yield* seedGoogle(standup);
      const notifications = yield* LocalNotifications;
      yield* setClock('2026-03-03T08:40:00Z');
      yield* notifications.run();
      expect(shown).toEqual([]);
      yield* TestClock.adjust('10 minutes');
      yield* notifications.run();
      yield* notifications.run();
      expect(shown).toEqual([STANDUP_KEY]);

      // Seen first 20 minutes into the event: "In 10 minutes" would be noise.
      const late = new EventRecord({
        ...standup,
        endUtc: Date.parse('2026-03-03T11:00:00Z'),
        id: 'late',
        startUtc: Date.parse('2026-03-03T10:00:00Z'),
      });
      yield* (yield* EventRepo).upsertMany([late]);
      yield* TestClock.adjust('80 minutes');
      yield* notifications.run();
      expect(shown).toEqual([STANDUP_KEY]);
    }).pipe(Effect.provide(testLayer(sink)));
  });

  it.effect('an event without its own reminders takes the calendar default', () => {
    const { shown, sink } = immediateSink();
    return Effect.gen(function* () {
      yield* seedGoogle(new EventRecord({ ...standup, id: 'plain', reminders: undefined }));
      yield* setClock('2026-03-03T08:30:00Z');
      yield* (yield* LocalNotifications).run();
      expect(shown).toEqual([`event:acc-1/cal-1/plain:${String(standup.startUtc)}:30`]);
    }).pipe(Effect.provide(testLayer(sink)));
  });

  it.effect(
    'a scheduled sink gets one merged plan, soonest first, and keeps birthdays when events go off',
    () => {
      const scheduled = scheduledSink();
      return Effect.gen(function* () {
        yield* enableBirthdays;
        yield* seedGoogle(standup);
        const notifications = yield* LocalNotifications;
        yield* setClock('2026-03-01T12:00:00Z');
        yield* notifications.run();
        yield* notifications.run();
        expect(scheduled.schedules).toHaveLength(1);
        expect(scheduled.schedules[0]!.map((plan) => plan.key)).toEqual([
          STANDUP_KEY,
          'birthday:device:a:2026-03-04:1',
          'birthday:device:a:2026-03-04:0',
        ]);
        expect(scheduled.asked()).toBe(1);

        yield* writeEventNotificationSettings({ enabled: false, includeAppleCalendar: false });
        yield* notifications.run();
        expect(scheduled.schedules).toHaveLength(2);
        expect(scheduled.schedules[1]!.map((plan) => plan.key)).toEqual([
          'birthday:device:a:2026-03-04:1',
          'birthday:device:a:2026-03-04:0',
        ]);

        yield* writeBirthdayReminderSettings({
          enabled: false,
          reminders: [
            { leadDays: 0, time: '09:00' },
            { leadDays: 1, time: '09:00' },
          ],
        });
        yield* notifications.run();
        yield* notifications.run();
        expect(scheduled.schedules).toHaveLength(3);
        expect(scheduled.schedules[2]).toEqual([]);
      }).pipe(Effect.provide(testLayer(scheduled.sink)));
    },
  );

  it.effect(
    'a scheduled sink clears delivered reminders on every pass, the schedule unchanged too',
    () => {
      const scheduled = scheduledSink();
      scheduled.presented.push(deliveredStandup());
      return Effect.gen(function* () {
        yield* seedGoogle(standup);
        const notifications = yield* LocalNotifications;
        yield* setClock('2026-03-01T12:00:00Z');
        yield* notifications.run();
        yield* notifications.run();
        expect(scheduled.schedules).toHaveLength(1);
        // Asked both times, nothing over yet.
        expect(scheduled.dismissed).toEqual([]);
        // The hand-over first, so a slow dismissal never delays it.
        expect(scheduled.calls).toEqual(['replace', 'dismiss', 'dismiss']);
        yield* TestClock.adjust('3 days');
        yield* notifications.run();
        expect(scheduled.dismissed).toEqual([STANDUP_KEY]);
      }).pipe(Effect.provide(testLayer(scheduled.sink)));
    },
  );

  it.effect('a dismissal the OS refuses costs neither the schedule nor the next try', () => {
    let refusals = 1;
    const scheduled = scheduledSink(true, undefined, () =>
      refusals-- > 0 ? Effect.fail(new Error('no presenter')) : Effect.void,
    );
    scheduled.presented.push(deliveredStandup(Date.parse('2026-03-01T11:00:00Z')));
    return Effect.gen(function* () {
      yield* seedGoogle(standup);
      const notifications = yield* LocalNotifications;
      yield* setClock('2026-03-01T12:00:00Z');
      yield* notifications.run();
      expect(scheduled.schedules).toHaveLength(1);
      expect(scheduled.dismissed).toEqual([]);
      expect(yield* (yield* DeviceSettingsRepo).get('localNotifications.scheduled')).toContain(
        STANDUP_KEY,
      );
      yield* TestClock.adjust('1 minute');
      yield* notifications.run();
      expect(scheduled.dismissed).toEqual([STANDUP_KEY]);
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });

  it.effect(
    'switched off, delivered reminders stay; switched back on, the next pass clears',
    () => {
      const scheduled = scheduledSink();
      scheduled.presented.push(deliveredStandup(Date.parse('2026-03-01T11:00:00Z')));
      return Effect.gen(function* () {
        yield* seedGoogle(standup);
        yield* writeEventNotificationSettings({
          dismissWhenOver: false,
          enabled: true,
          includeAppleCalendar: false,
        });
        const notifications = yield* LocalNotifications;
        yield* setClock('2026-03-01T12:00:00Z');
        yield* notifications.run();
        // Still scheduled with its deadline, so switching back on works at once.
        expect(scheduled.schedules[0]![0]!.dismissAt).toBe(standup.endUtc);
        expect(scheduled.dismissed).toEqual([]);
        yield* writeEventNotificationSettings({
          dismissWhenOver: true,
          enabled: true,
          includeAppleCalendar: false,
        });
        yield* TestClock.adjust('1 minute');
        yield* notifications.run();
        expect(scheduled.dismissed).toEqual([STANDUP_KEY]);
        expect(scheduled.schedules).toHaveLength(1);
      }).pipe(Effect.provide(testLayer(scheduled.sink)));
    },
  );

  it.effect('with event notifications off, the ones already delivered still leave', () => {
    const scheduled = scheduledSink();
    scheduled.presented.push(deliveredStandup(Date.parse('2026-03-01T11:00:00Z')));
    return Effect.gen(function* () {
      yield* seedGoogle(standup);
      yield* writeEventNotificationSettings({ enabled: false, includeAppleCalendar: false });
      yield* setClock('2026-03-01T12:00:00Z');
      yield* (yield* LocalNotifications).run();
      // Nothing new is planned, yet "Remove When Over" (unset: on) still applies.
      expect(scheduled.schedules).toEqual([[]]);
      expect(scheduled.dismissed).toEqual([STANDUP_KEY]);
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });

  it.effect('a schedule the OS refuses still clears delivered reminders', () => {
    const scheduled = scheduledSink(true, () => Effect.fail(new Error('refused')));
    scheduled.presented.push(deliveredStandup(Date.parse('2026-03-01T11:00:00Z')));
    return Effect.gen(function* () {
      yield* seedGoogle(standup);
      yield* setClock('2026-03-01T12:00:00Z');
      yield* (yield* LocalNotifications).run();
      expect(scheduled.schedules).toEqual([]);
      expect(scheduled.dismissed).toEqual([STANDUP_KEY]);
      expect(yield* (yield* DeviceSettingsRepo).get('localNotifications.scheduled')).toBeNull();
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });

  it.effect('a later end re-hands the schedule with the new dismissal', () => {
    const scheduled = scheduledSink();
    return Effect.gen(function* () {
      yield* seedGoogle(standup);
      const notifications = yield* LocalNotifications;
      yield* setClock('2026-03-01T12:00:00Z');
      yield* notifications.run();
      expect(scheduled.schedules[0]![0]!.dismissAt).toBe(standup.endUtc);
      const longer = new EventRecord({ ...standup, endUtc: standup.endUtc + 3_600_000 });
      yield* (yield* EventRepo).upsertMany([longer]);
      yield* notifications.run();
      expect(scheduled.schedules).toHaveLength(2);
      expect(scheduled.schedules[1]![0]!.dismissAt).toBe(longer.endUtc);
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });

  it.effect(
    'task reminders join the schedule: a day-only task at the set time, a timed reminder at its own',
    () => {
      const scheduled = scheduledSink();
      return Effect.gen(function* () {
        yield* seedGoogle(standup);
        yield* seedTasks(rent, callBank);
        const notifications = yield* LocalNotifications;
        yield* setClock('2026-03-01T12:00:00Z');
        yield* notifications.run();
        expect(scheduled.schedules[0]!.map((plan) => [plan.key, plan.fireAt])).toEqual([
          [STANDUP_KEY, Date.parse('2026-03-03T08:50:00Z')],
          [RENT_KEY, Date.parse('2026-03-03T09:00:00Z')],
          [BANK_KEY, Date.parse('2026-03-03T14:00:00Z')],
        ]);
        expect(scheduled.schedules[0]!.map((plan) => plan.body).slice(1)).toEqual([
          'Due today · Inbox',
          'Due today · 2:00 PM · Errands',
        ]);
        expect(scheduled.schedules[0]![1]!.target).toEqual({
          accountId: 'acc-1',
          dueDate: '2026-03-03',
          kind: 'task',
          listId: 'inbox',
          taskId: 'rent',
        });
        // Apple Reminders leave once switched off; the time setting moves the day-only one.
        yield* writeTaskNotificationSettings({
          enabled: true,
          includeAppleReminders: false,
          time: '07:30',
        });
        yield* notifications.run();
        expect(scheduled.schedules[1]!.map((plan) => [plan.key, plan.fireAt])).toEqual([
          [RENT_KEY, Date.parse('2026-03-03T07:30:00Z')],
          [STANDUP_KEY, Date.parse('2026-03-03T08:50:00Z')],
        ]);
      }).pipe(Effect.provide(testLayer(scheduled.sink)));
    },
  );

  it.effect('a task checked off re-plans on its own, debounced', () => {
    const scheduled = scheduledSink();
    return Effect.gen(function* () {
      yield* seedTasks(rent);
      yield* setClock('2026-03-01T12:00:00Z');
      const notifications = yield* LocalNotifications;
      yield* notifications.start();
      yield* TestClock.adjust('1 second');
      expect(scheduled.schedules.map((plans) => plans.map((plan) => plan.key))).toEqual([
        [RENT_KEY],
      ]);
      yield* done(rent);
      yield* TestClock.adjust('3 seconds');
      expect(scheduled.schedules.map((plans) => plans.map((plan) => plan.key))).toEqual([
        [RENT_KEY],
        [],
      ]);
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });

  it.effect(
    'a delivered task notification leaves once the task is done — per provider, with its switch',
    () => {
      const scheduled = scheduledSink();
      scheduled.presented.push(deliveredTask(rent, RENT_KEY), deliveredTask(callBank, BANK_KEY));
      return Effect.gen(function* () {
        yield* seedTasks(rent, callBank);
        const notifications = yield* LocalNotifications;
        yield* setClock('2026-03-03T15:00:00Z');
        yield* notifications.run();
        // Both still open: both stay.
        expect(scheduled.dismissed).toEqual([]);
        yield* done(rent);
        yield* done(callBank);
        yield* writeTaskNotificationSettings({
          dismissRemindersWhenDone: false,
          enabled: true,
          includeAppleReminders: true,
          time: '09:00',
        });
        yield* notifications.run();
        expect(scheduled.dismissed).toEqual([RENT_KEY]);
        yield* writeTaskNotificationSettings({
          dismissRemindersWhenDone: true,
          enabled: true,
          includeAppleReminders: true,
          time: '09:00',
        });
        yield* notifications.run();
        expect(scheduled.dismissed).toEqual([RENT_KEY, BANK_KEY]);
      }).pipe(Effect.provide(testLayer(scheduled.sink)));
    },
  );

  it.effect(
    'a deleted task takes its notification along; "Remove Tasks When Done" off keeps it, notifications off or not',
    () => {
      const scheduled = scheduledSink();
      scheduled.presented.push(deliveredTask(rent, RENT_KEY));
      return Effect.gen(function* () {
        yield* seedTasks(rent);
        yield* writeTaskNotificationSettings({
          dismissTasksWhenDone: false,
          enabled: false,
          includeAppleReminders: true,
          time: '09:00',
        });
        const notifications = yield* LocalNotifications;
        yield* setClock('2026-03-03T15:00:00Z');
        yield* (yield* TaskRepo).removeTask('acc-1', 'inbox', 'rent');
        yield* notifications.run();
        expect(scheduled.dismissed).toEqual([]);
        yield* writeTaskNotificationSettings({
          enabled: false,
          includeAppleReminders: true,
          time: '09:00',
        });
        // Gone for a moment is not gone: a move from another device lands
        // list by list. Gone for a minute is.
        yield* notifications.run();
        expect(scheduled.dismissed).toEqual([]);
        yield* TestClock.adjust('1 minute');
        yield* notifications.run();
        expect(scheduled.dismissed).toEqual([RENT_KEY]);
      }).pipe(Effect.provide(testLayer(scheduled.sink)));
    },
  );

  it.effect(
    'a timed reminder is judged by its instant: its day re-read in another zone keeps the notification, a new instant loses it',
    () => {
      const scheduled = scheduledSink();
      scheduled.presented.push(deliveredTask(callBank, BANK_KEY));
      return Effect.gen(function* () {
        yield* seedTasks(callBank);
        const taskRepo = yield* TaskRepo;
        const notifications = yield* LocalNotifications;
        yield* setClock('2026-03-03T15:00:00Z');
        yield* taskRepo.upsertTasks([new TaskRecord({ ...callBank, dueDate: '2026-03-04' })], 1);
        yield* notifications.run();
        expect(scheduled.dismissed).toEqual([]);
        yield* taskRepo.upsertTasks(
          [new TaskRecord({ ...callBank, dueUtc: Date.parse('2026-03-04T14:00:00Z') })],
          1,
        );
        yield* notifications.run();
        expect(scheduled.dismissed).toEqual([BANK_KEY]);
      }).pipe(Effect.provide(testLayer(scheduled.sink)));
    },
  );

  it.effect('a task stored on two lists mid-move plans once', () => {
    const scheduled = scheduledSink();
    return Effect.gen(function* () {
      yield* seedTasks(rent);
      const taskRepo = yield* TaskRepo;
      yield* taskRepo.upsertLists([home], 1);
      yield* taskRepo.upsertTasks([new TaskRecord({ ...rent, listId: 'home' })], 1);
      yield* setClock('2026-03-01T12:00:00Z');
      yield* (yield* LocalNotifications).run();
      expect(scheduled.schedules.map((plans) => plans.map((plan) => plan.key))).toEqual([
        [RENT_KEY],
      ]);
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });

  it.effect(
    'a task moved to another list keeps its notification; one moved to another day loses it',
    () => {
      const scheduled = scheduledSink();
      scheduled.presented.push(deliveredTask(rent, RENT_KEY));
      return Effect.gen(function* () {
        yield* seedTasks(rent);
        const taskRepo = yield* TaskRepo;
        yield* taskRepo.upsertLists([home], 1);
        const notifications = yield* LocalNotifications;
        yield* setClock('2026-03-03T15:00:00Z');
        // Moved: the same id on another list, the inbox row gone.
        yield* taskRepo.removeTask('acc-1', 'inbox', 'rent');
        yield* taskRepo.upsertTasks([new TaskRecord({ ...rent, listId: 'home' })], 1);
        yield* notifications.run();
        expect(scheduled.dismissed).toEqual([]);
        // Re-dated: the notification spoke of the 3rd.
        yield* taskRepo.upsertTasks(
          [new TaskRecord({ ...rent, dueDate: '2026-03-04', listId: 'home' })],
          1,
        );
        yield* notifications.run();
        expect(scheduled.dismissed).toEqual([RENT_KEY]);
      }).pipe(Effect.provide(testLayer(scheduled.sink)));
    },
  );

  it.effect(
    'an immediate sink shows what came due since its last pass, not a plan already past',
    () => {
      const { shown, sink } = immediateSink();
      return Effect.gen(function* () {
        yield* seedTasks(rent);
        const notifications = yield* LocalNotifications;
        yield* setClock('2026-03-03T08:00:00Z');
        yield* notifications.run();
        expect(shown).toEqual([]);
        // 09:00 fell between two passes: a Mac asleep through it catches up.
        yield* TestClock.adjust('2 hours');
        yield* notifications.run();
        expect(shown).toEqual([RENT_KEY]);
        // Created at 10:00 and due today: its 09:00 was never missed.
        yield* (yield* TaskRepo).upsertTasks(
          [new TaskRecord({ ...rent, id: 'tax', title: 'File the tax' })],
          1,
        );
        yield* notifications.run();
        expect(shown).toEqual([RENT_KEY]);
        // Nor is a notify time moved to earlier than now.
        yield* writeTaskNotificationSettings({
          enabled: true,
          includeAppleReminders: true,
          time: '09:30',
        });
        yield* notifications.run();
        expect(shown).toEqual([RENT_KEY]);
      }).pipe(Effect.provide(testLayer(sink)));
    },
  );

  it.effect('Apple Calendar events notify only when the setting includes them', () => {
    const { shown, sink } = immediateSink();
    const dentist: AppleEventJson = {
      alarms: [-15],
      calendarId: 'ek-home',
      endUtc: Date.parse('2026-03-03T10:00:00Z'),
      hasRecurrence: false,
      id: 'ek-dentist',
      isAllDay: false,
      isDetached: false,
      startUtc: Date.parse('2026-03-03T09:00:00Z'),
      status: 'confirmed',
      timeZone: 'UTC',
      title: 'Dentist',
      updatedAt: 1,
    };
    const apple = makeFakeAppleCalendarClient({
      authorization: 'fullAccess',
      calendars: [
        {
          allowsModifications: true,
          colorHex: '#1badf8',
          id: 'ek-home',
          isDefault: true,
          sourceTitle: 'iCloud',
          sourceType: 'calDAV',
          title: 'Home',
          type: 'calDAV',
        },
      ],
      events: [{ event: dentist }],
    });
    return Effect.gen(function* () {
      yield* (yield* AccountRepo).upsert(
        new Account({
          contactsEnabled: false,
          createdAt: 1,
          displayName: 'Apple Calendar',
          email: '',
          id: APPLE_CALENDAR_ACCOUNT_ID,
          provider: 'apple',
          status: 'ok',
          tasksEnabled: false,
        }),
      );
      yield* (yield* CalendarRepo).upsertMany([
        new CalendarInfo({
          accessRole: 'owner',
          accountId: APPLE_CALENDAR_ACCOUNT_ID,
          colorHex: '#1badf8',
          id: 'ek-home',
          isPrimary: true,
          isVisible: true,
          provider: 'apple',
          summary: 'Home',
          timeZone: 'UTC',
        }),
      ]);
      const notifications = yield* LocalNotifications;
      // The 15-minute reminder of a 9:00 dentist: not planned while the
      // setting leaves Apple Calendar out, planned once it includes it, and
      // shown when its moment comes.
      yield* setClock('2026-03-03T08:30:00Z');
      yield* notifications.run();
      yield* writeEventNotificationSettings({ enabled: true, includeAppleCalendar: true });
      yield* notifications.run();
      expect(shown).toEqual([]);
      yield* TestClock.adjust('16 minutes');
      yield* notifications.run();
      expect(shown).toEqual([
        `event:${APPLE_CALENDAR_ACCOUNT_ID}/ek-home/ek-dentist:${String(dentist.startUtc)}:15`,
      ]);
    }).pipe(Effect.provide(testLayer(sink, apple.client)));
  });

  it.effect('a refused schedule is retried on the next pass; a new time reschedules', () => {
    let failOnce = true;
    const scheduled = scheduledSink(true, () =>
      Effect.suspend(() => {
        if (failOnce) {
          failOnce = false;
          return Effect.fail(new Error('UNUserNotificationCenter refused'));
        }
        return Effect.void;
      }),
    );
    return Effect.gen(function* () {
      yield* enableBirthdays;
      const notifications = yield* LocalNotifications;
      yield* setClock('2026-03-01T12:00:00Z');
      yield* notifications.run();
      expect(scheduled.schedules).toHaveLength(0);
      yield* notifications.run();
      expect(scheduled.schedules).toHaveLength(1);
      // Same keys, later delivery time: the OS must hear about it.
      yield* writeBirthdayReminderSettings({
        enabled: true,
        reminders: [
          { leadDays: 0, time: '15:00' },
          { leadDays: 1, time: '15:00' },
        ],
      });
      yield* notifications.run();
      expect(scheduled.schedules).toHaveLength(2);
      expect(scheduled.schedules[1]![0]!.fireAt).toBe(Date.parse('2026-03-03T15:00:00Z'));
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });

  it.effect('each pass reads the device zone: a 9:00 reminder follows a flight', () => {
    const scheduled = scheduledSink();
    let zone = 'UTC';
    return Effect.gen(function* () {
      yield* enableBirthdays;
      const notifications = yield* LocalNotifications;
      yield* setClock('2026-03-01T12:00:00Z');
      yield* notifications.run();
      // Landed in Tokyo with the app still running.
      zone = 'Asia/Tokyo';
      yield* notifications.run();
      const [before, after] = scheduled.schedules.map((schedule) =>
        schedule.map((planned) => planned.fireAt),
      );
      expect(before!.length).toBeGreaterThan(0);
      // 09:00 in Tokyo is 00:00Z: nine hours earlier than 09:00 in UTC.
      expect(after).toEqual(before!.map((fireAt) => fireAt - 9 * 60 * 60_000));
    }).pipe(
      Effect.provide(testLayer(scheduled.sink, unavailableAppleCalendarClient('test'), () => zone)),
    );
  });

  it.effect(
    "an event reminder adds the primary zone's time, read against the pass's device zone",
    () => {
      const scheduled = scheduledSink();
      let zone = 'UTC';
      return Effect.gen(function* () {
        yield* seedGoogle(standup);
        const notifications = yield* LocalNotifications;
        yield* setClock('2026-03-01T12:00:00Z');
        yield* writeTimeZoneSettings({
          primary: 'Europe/Vienna',
          zones: ['device', 'Europe/Vienna'],
        });
        yield* notifications.run();
        // The device entry as primary is whatever zone the pass reads: no second clock.
        yield* writeTimeZoneSettings({ primary: 'device', zones: ['device', 'Europe/Vienna'] });
        zone = 'Asia/Tokyo';
        yield* notifications.run();
        expect(scheduled.schedules.map((schedule) => schedule.map((plan) => plan.body))).toEqual([
          ['In 10 minutes · 9:00 AM (10:00 AM Vienna)'],
          ['In 10 minutes · 6:00 PM'],
        ]);
      }).pipe(
        Effect.provide(
          testLayer(scheduled.sink, unavailableAppleCalendarClient('test'), () => zone),
        ),
      );
    },
  );

  it.effect(
    'passes are serialized: a disabling pass is not overtaken by a slow enabled one',
    () => {
      const release = Effect.runSync(Deferred.make<void>());
      let first = true;
      const scheduled = scheduledSink(true, () =>
        Effect.suspend(() => {
          if (first) {
            first = false;
            return Deferred.await(release);
          }
          return Effect.void;
        }),
      );
      return Effect.gen(function* () {
        yield* enableBirthdays;
        const notifications = yield* LocalNotifications;
        yield* setClock('2026-03-01T12:00:00Z');
        const slow = yield* Effect.forkChild(notifications.run());
        yield* Effect.yieldNow;
        yield* writeBirthdayReminderSettings({
          enabled: false,
          reminders: [
            { leadDays: 0, time: '09:00' },
            { leadDays: 1, time: '09:00' },
          ],
        });
        const disabling = yield* Effect.forkChild(notifications.run());
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Effect.all([Fiber.join(slow), Fiber.join(disabling)], { discard: true });
        expect(scheduled.schedules.map((schedule) => schedule.length)).toEqual([2, 0]);
      }).pipe(Effect.provide(testLayer(scheduled.sink)));
    },
  );

  it.effect('a scheduled sink gets the soonest 60; later ones follow as time passes', () => {
    const scheduled = scheduledSink();
    const hour = 60 * 60 * 1000;
    const first = Date.parse('2026-03-01T13:00:00Z');
    // Hourly events, well inside the 7-day horizon: 70 plans for 60 slots.
    const events = Array.from(
      { length: 70 },
      (_, i) =>
        new EventRecord({
          ...standup,
          endUtc: first + i * hour + hour / 2,
          id: `e${String(i)}`,
          startUtc: first + i * hour,
        }),
    );
    const key = (i: number) => `event:acc-1/cal-1/e${String(i)}:${String(first + i * hour)}:10`;
    return Effect.gen(function* () {
      yield* seedGoogle(...events);
      const notifications = yield* LocalNotifications;
      yield* setClock('2026-03-01T12:00:00Z');
      yield* notifications.run();
      expect(scheduled.schedules[0]!.map((plan) => plan.key)).toEqual(
        Array.from({ length: 60 }, (_, i) => key(i)),
      );
      // Ten of them delivered: the freed slots take the next ten.
      yield* TestClock.adjust('10 hours');
      yield* notifications.run();
      expect(scheduled.schedules[1]!.map((plan) => plan.key)).toEqual(
        Array.from({ length: 60 }, (_, i) => key(i + 10)),
      );
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });

  it.effect('a scheduled sink without permission schedules nothing', () => {
    const scheduled = scheduledSink(false);
    return Effect.gen(function* () {
      yield* enableBirthdays;
      yield* setClock('2026-03-01T12:00:00Z');
      yield* (yield* LocalNotifications).run();
      expect(scheduled.schedules).toEqual([]);
      expect(yield* (yield* DeviceSettingsRepo).get('localNotifications.scheduled')).toBeNull();
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });
});

/** A SyncEngine whose one pass is `syncAll` — the pull under test. */
const stubEngine = (syncAll: Effect.Effect<void, unknown, EventRepo>) =>
  Layer.effect(SyncEngine)(
    Effect.map(Effect.context<EventRepo>(), (context) => ({
      exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      start: () => Effect.void,
      syncAll: () => Effect.orDie(Effect.provide(syncAll, context)),
      syncNow: () => Effect.orDie(Effect.provide(syncAll, context)),
    })),
  );

/** Mirrors that count their passes and do nothing else. */
const stubMirrors = (passes: Array<unknown>) =>
  Layer.succeed(Mirrors, {
    createCalendar: () => Effect.die('not used'),
    list: () => Effect.succeed([]),
    preview: () => Effect.die('not used'),
    remove: () => Effect.void,
    run: (options) => Effect.sync(() => void passes.push(options?.budget)),
    save: () => Effect.die('not used'),
    setEnabled: () => Effect.void,
    start: () => Effect.void,
  });

describe('backgroundRefresh', () => {
  it.effect(
    'reschedules what the pull brought in, then runs the mirrors within their budget',
    () => {
      const scheduled = scheduledSink();
      const passes: Array<unknown> = [];
      const pulled = Effect.flatMap(EventRepo, (repo) => repo.upsertMany([standup]));
      return Effect.gen(function* () {
        yield* seedGoogle();
        yield* setClock('2026-03-01T12:00:00Z');
        yield* backgroundRefresh('20 seconds', '20 seconds');
        expect(scheduled.schedules.map((plans) => plans.map((plan) => plan.key))).toEqual([
          [STANDUP_KEY],
        ]);
        expect(passes).toEqual(['20 seconds']);
        // The background task clears delivered reminders too.
        expect(scheduled.calls).toEqual(['replace', 'dismiss']);
      }).pipe(
        Effect.provide(stubMirrors(passes)),
        Effect.provide(stubEngine(pulled).pipe(Layer.provideMerge(testLayer(scheduled.sink)))),
      );
    },
  );

  it.effect('a sync past its budget still refreshes the schedule from local data', () => {
    const scheduled = scheduledSink();
    return Effect.gen(function* () {
      yield* seedGoogle(standup);
      yield* setClock('2026-03-01T12:00:00Z');
      const refresh = yield* Effect.forkChild(backgroundRefresh('20 seconds', '20 seconds'));
      yield* TestClock.adjust('20 seconds');
      yield* Fiber.join(refresh);
      expect(scheduled.schedules.map((plans) => plans.map((plan) => plan.key))).toEqual([
        [STANDUP_KEY],
      ]);
    }).pipe(
      Effect.provide(stubMirrors([])),
      Effect.provide(stubEngine(Effect.never).pipe(Layer.provideMerge(testLayer(scheduled.sink)))),
    );
  });

  it.effect('a sync that dies still refreshes the schedule', () => {
    const scheduled = scheduledSink();
    return Effect.gen(function* () {
      yield* seedGoogle(standup);
      yield* setClock('2026-03-01T12:00:00Z');
      yield* backgroundRefresh('20 seconds', '20 seconds');
      expect(scheduled.schedules).toHaveLength(1);
    }).pipe(
      Effect.provide(stubMirrors([])),
      Effect.provide(
        stubEngine(Effect.die(new Error('errSecInteractionNotAllowed'))).pipe(
          Layer.provideMerge(testLayer(scheduled.sink)),
        ),
      ),
    );
  });
});
