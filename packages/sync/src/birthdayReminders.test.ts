import { ContactsClient, makeFakeContactsClient } from '@calendar/contacts';
import type { PlannedNotification } from '@calendar/core';
import { DeviceSettingsRepo, reposLayer, runMigrations } from '@calendar/db';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Duration, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { BirthdayReminders } from './birthdayReminders.ts';
import { DeviceContacts } from './deviceContacts.ts';
import { writeBirthdayReminderSettings } from './deviceSettings.ts';
import { NotificationSink, type NotificationSinkShape } from './notificationSink.ts';

const alice = { contactId: 'a', day: 4, displayName: 'Alice', month: 3, year: 1994 };

const immediateSink = () => {
  const shown: Array<string> = [];
  const sink: NotificationSinkShape = {
    kind: 'immediate',
    show: (planned) => Effect.sync(() => void shown.push(planned.key)),
  };
  return { shown, sink };
};

const scheduledSink = (granted = true) => {
  const schedules: Array<ReadonlyArray<PlannedNotification>> = [];
  let asked = 0;
  const sink: NotificationSinkShape = {
    ensurePermission: () =>
      Effect.sync(() => {
        asked += 1;
        return granted;
      }),
    kind: 'scheduled',
    replaceSchedule: (planned) => Effect.sync(() => void schedules.push(planned)),
  };
  return { asked: () => asked, schedules, sink };
};

const testLayer = (sink: NotificationSinkShape) =>
  BirthdayReminders.layer({ timeZone: 'UTC' }).pipe(
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

const enable = writeBirthdayReminderSettings({ enabled: true, leadDays: [0, 1], time: '09:00' });

describe('BirthdayReminders', () => {
  it.effect('an immediate sink fires each due reminder once, across runs', () => {
    const { shown, sink } = immediateSink();
    return Effect.gen(function* () {
      yield* enable;
      const reminders = yield* BirthdayReminders;
      yield* setClock('2026-03-03T10:00:00Z');
      yield* reminders.run();
      yield* reminders.run();
      expect(shown).toEqual(['device:a:2026-03-04:1']);
      yield* TestClock.adjust('24 hours');
      yield* reminders.run();
      expect(shown).toEqual(['device:a:2026-03-04:1', 'device:a:2026-03-04:0']);
    }).pipe(Effect.provide(testLayer(sink)));
  });

  it.effect('catches up on a reminder from the last day, not older ones', () => {
    const { shown, sink } = immediateSink();
    return Effect.gen(function* () {
      yield* enable;
      const reminders = yield* BirthdayReminders;
      // 09:00 on the 4th is 2 h old (fires); 09:00 on the 3rd is 26 h old (dropped).
      yield* setClock('2026-03-04T11:00:00Z');
      yield* reminders.run();
      expect(shown).toEqual(['device:a:2026-03-04:0']);
    }).pipe(Effect.provide(testLayer(sink)));
  });

  it.effect('does nothing while disabled', () => {
    const { shown, sink } = immediateSink();
    return Effect.gen(function* () {
      const reminders = yield* BirthdayReminders;
      yield* setClock('2026-03-04T10:00:00Z');
      yield* reminders.run();
      expect(shown).toEqual([]);
    }).pipe(Effect.provide(testLayer(sink)));
  });

  it.effect('a scheduled sink gets the upcoming plan once, and an empty one when disabled', () => {
    const scheduled = scheduledSink();
    return Effect.gen(function* () {
      yield* enable;
      const reminders = yield* BirthdayReminders;
      yield* setClock('2026-03-01T12:00:00Z');
      yield* reminders.run();
      yield* reminders.run();
      expect(scheduled.schedules).toHaveLength(1);
      expect(scheduled.schedules[0]!.map((plan) => plan.key)).toEqual([
        'device:a:2026-03-04:1',
        'device:a:2026-03-04:0',
      ]);
      expect(scheduled.asked()).toBe(1);

      yield* writeBirthdayReminderSettings({ enabled: false, leadDays: [0, 1], time: '09:00' });
      yield* reminders.run();
      yield* reminders.run();
      expect(scheduled.schedules).toHaveLength(2);
      expect(scheduled.schedules[1]).toEqual([]);
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });

  it.effect('a scheduled sink without permission schedules nothing', () => {
    const scheduled = scheduledSink(false);
    return Effect.gen(function* () {
      yield* enable;
      yield* setClock('2026-03-01T12:00:00Z');
      yield* (yield* BirthdayReminders).run();
      expect(scheduled.schedules).toEqual([]);
      expect(yield* (yield* DeviceSettingsRepo).get('birthdayReminders.scheduled')).toBeNull();
    }).pipe(Effect.provide(testLayer(scheduled.sink)));
  });
});
