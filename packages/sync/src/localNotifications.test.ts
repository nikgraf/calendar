import {
  type AppleEventJson,
  makeFakeAppleCalendarClient,
  unavailableAppleCalendarClient,
} from '@calendar/apple-calendar';
import { ContactsClient, makeFakeContactsClient } from '@calendar/contacts';
import {
  Account,
  APPLE_CALENDAR_ACCOUNT_ID,
  CalendarInfo,
  EventRecord,
  EventReminders,
  type PlannedNotification,
  ReminderOverride,
} from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  DeviceSettingsRepo,
  EventRepo,
  reposLayer,
  runMigrations,
} from '@calendar/db';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Deferred, Duration, Effect, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vitest';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { backgroundRefresh } from './backgroundRefresh.ts';
import { DeviceContacts } from './deviceContacts.ts';
import { SyncEngine } from './engine.ts';
import {
  writeBirthdayReminderOverrides,
  writeBirthdayReminderSettings,
  writeEventNotificationSettings,
} from './deviceSettings.ts';
import { LocalNotifications } from './localNotifications.ts';
import { Mirrors } from './mirrors.ts';
import { NotificationSink, type NotificationSinkShape } from './notificationSink.ts';

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
) => {
  const schedules: Array<ReadonlyArray<PlannedNotification>> = [];
  let asked = 0;
  const sink: NotificationSinkShape = {
    ensurePermission: () =>
      Effect.sync(() => {
        asked += 1;
        return granted;
      }),
    kind: 'scheduled',
    replaceSchedule: (planned) =>
      Effect.andThen(onReplace(planned), () => Effect.sync(() => void schedules.push(planned))),
  };
  return { asked: () => asked, schedules, sink };
};

const testLayer = (sink: NotificationSinkShape, apple = unavailableAppleCalendarClient('test')) =>
  LocalNotifications.layer({ timeZone: 'UTC' }).pipe(
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
  leadDays: [0, 1],
  time: '09:00',
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

const seedGoogle = (...events: ReadonlyArray<EventRecord>) =>
  Effect.gen(function* () {
    yield* (yield* AccountRepo).upsert(
      new Account({
        contactsEnabled: false,
        createdAt: 1,
        email: 'nik@nikgraf.com',
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
      yield* writeBirthdayReminderSettings({ enabled: true, leadDays: [0], time: '09:00' });
      yield* writeBirthdayReminderOverrides([
        { day: 4, displayName: 'Alice', leadDays: [1], month: 3 },
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
        { day: 4, displayName: 'Alice', leadDays: [], month: 3 },
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
      yield* (yield* LocalNotifications).run();
      expect(asked()).toBe(0);
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

  it.effect('honours the fired map of the birthday-only scheduler once', () => {
    const { shown, sink } = immediateSink();
    return Effect.gen(function* () {
      yield* enableBirthdays;
      yield* (yield* DeviceSettingsRepo).set('birthdayReminders.fired', {
        'device:a:2026-03-04:1': Date.parse('2026-03-03T09:00:00Z'),
      });
      yield* setClock('2026-03-03T10:00:00Z');
      yield* (yield* LocalNotifications).run();
      expect(shown).toEqual([]);
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

  it.effect('does nothing while both producers are off', () => {
    const { shown, sink } = immediateSink();
    return Effect.gen(function* () {
      yield* seedGoogle(standup);
      yield* writeEventNotificationSettings({ enabled: false, includeAppleCalendar: false });
      const notifications = yield* LocalNotifications;
      yield* setClock('2026-03-04T10:00:00Z');
      yield* notifications.run();
      expect(shown).toEqual([]);
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

        yield* writeBirthdayReminderSettings({ enabled: false, leadDays: [0, 1], time: '09:00' });
        yield* notifications.run();
        yield* notifications.run();
        expect(scheduled.schedules).toHaveLength(3);
        expect(scheduled.schedules[2]).toEqual([]);
      }).pipe(Effect.provide(testLayer(scheduled.sink)));
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
      yield* setClock('2026-03-03T08:45:00Z');
      yield* notifications.run();
      expect(shown).toEqual([]);
      yield* writeEventNotificationSettings({ enabled: true, includeAppleCalendar: true });
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
      yield* writeBirthdayReminderSettings({ enabled: true, leadDays: [0, 1], time: '15:00' });
      yield* notifications.run();
      expect(scheduled.schedules).toHaveLength(2);
      expect(scheduled.schedules[1]![0]!.fireAt).toBe(Date.parse('2026-03-03T15:00:00Z'));
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });

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
        yield* writeBirthdayReminderSettings({ enabled: false, leadDays: [0, 1], time: '09:00' });
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
