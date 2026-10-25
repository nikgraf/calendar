import {
  type BirthdayLeadDays,
  DEFAULT_BIRTHDAY_REMINDER_SETTINGS,
  DEFAULT_ONBOARDING_STATE,
  DEFAULT_TIME_ZONE_SETTINGS,
  DEFAULT_VIEW_PREFERENCES,
  Temporal,
} from '@calendar/core';
import { DeviceSettingsRepo, reposLayer, runMigrations } from '@calendar/db';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Deferred, Effect, Layer, Schema } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import {
  BIRTHDAY_REMINDER_OVERRIDES_KEY,
  BIRTHDAY_REMINDERS_KEY,
  ONBOARDING_KEY,
  readBirthdayReminderOverrides,
  readBirthdayReminderSettings,
  readOnboarding,
  readPrimaryTimeZone,
  readTimeZoneSettings,
  readViewPreferences,
  TIME_ZONES_KEY,
  updateOnboarding,
  VIEW_PREFERENCES_KEY,
  writeBirthdayReminderOverrides,
  writeBirthdayReminderSettings,
  writeOnboarding,
  writeTimeZoneSettings,
  writeViewPreferences,
} from './deviceSettings.ts';

const at = (leadDays: BirthdayLeadDays, time = '09:00') => ({ leadDays, time });

const dbLayer = () =>
  reposLayer.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

describe('birthday reminder settings', () => {
  it.effect('defaults when nothing is stored, round-trips canonical values', () =>
    Effect.gen(function* () {
      expect(yield* readBirthdayReminderSettings).toEqual(DEFAULT_BIRTHDAY_REMINDER_SETTINGS);
      yield* writeBirthdayReminderSettings({
        enabled: true,
        reminders: [at(7, '18:30'), at(0, '08:00'), at(7, '19:00')],
      });
      expect(yield* readBirthdayReminderSettings).toEqual({
        enabled: true,
        reminders: [at(0, '08:00'), at(7, '19:00')],
      });
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('round-trips the weekend, days Monday first, and reads an older row as before', () =>
    Effect.gen(function* () {
      // A row written before the weekend fields existed keeps its fields.
      yield* (yield* DeviceSettingsRepo).set(VIEW_PREFERENCES_KEY, {
        allDayLaneCollapsed: true,
        lastView: 'month',
      });
      expect(yield* readViewPreferences).toEqual({ allDayLaneCollapsed: true, lastView: 'month' });
      yield* writeViewPreferences({
        allDayLaneCollapsed: true,
        lastView: 'month',
        weekendDays: ['SA', 'FR'],
        weekendShading: false,
      });
      expect(yield* readViewPreferences).toEqual({
        allDayLaneCollapsed: true,
        lastView: 'month',
        weekendDays: ['FR', 'SA'],
        weekendShading: false,
      });
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('a stored value that no longer decodes reads as the defaults', () =>
    Effect.gen(function* () {
      yield* (yield* DeviceSettingsRepo).set(BIRTHDAY_REMINDERS_KEY, { reminders: [at(0)] });
      expect(yield* readBirthdayReminderSettings).toEqual(DEFAULT_BIRTHDAY_REMINDER_SETTINGS);
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('reads a value saved before each reminder had its own time at its one time', () =>
    Effect.gen(function* () {
      const repo = yield* DeviceSettingsRepo;
      yield* repo.set(BIRTHDAY_REMINDERS_KEY, { enabled: true, leadDays: [7, 1], time: '18:30' });
      yield* repo.set(BIRTHDAY_REMINDER_OVERRIDES_KEY, [
        { day: 4, displayName: 'Alice', leadDays: [14], month: 3 },
      ]);
      expect(yield* readBirthdayReminderSettings).toEqual({
        enabled: true,
        reminders: [at(1, '18:30'), at(7, '18:30')],
      });
      expect(yield* readBirthdayReminderOverrides).toEqual([
        { day: 4, displayName: 'Alice', month: 3, reminders: [at(14, '18:30')] },
      ]);
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('the first save over the old shape keeps the people at its time', () =>
    Effect.gen(function* () {
      const repo = yield* DeviceSettingsRepo;
      yield* repo.set(BIRTHDAY_REMINDERS_KEY, { enabled: true, leadDays: [0], time: '18:30' });
      yield* repo.set(BIRTHDAY_REMINDER_OVERRIDES_KEY, [
        { day: 4, displayName: 'Alice', leadDays: [1], month: 3 },
      ]);
      yield* writeBirthdayReminderSettings({ enabled: true, reminders: [at(0, '07:00')] });
      expect(yield* repo.get(BIRTHDAY_REMINDER_OVERRIDES_KEY)).toEqual([
        { day: 4, displayName: 'Alice', leadDays: [1], month: 3, reminders: [at(1, '18:30')] },
      ]);
      expect(yield* readBirthdayReminderOverrides).toEqual([
        { day: 4, displayName: 'Alice', month: 3, reminders: [at(1, '18:30')] },
      ]);
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('two saves over the old shape land in the order they were made', () =>
    Effect.gen(function* () {
      const repo = yield* DeviceSettingsRepo;
      yield* repo.set(BIRTHDAY_REMINDERS_KEY, { enabled: true, leadDays: [0], time: '18:30' });
      yield* repo.set(BIRTHDAY_REMINDER_OVERRIDES_KEY, [
        { day: 4, displayName: 'Alice', leadDays: [1], month: 3 },
      ]);
      // The first one rewrites Alice first; a second made just then sees
      // nothing left to rewrite and must still not overtake it.
      const real = yield* DeviceSettingsRepo;
      const rewritten = yield* Deferred.make<void>();
      const pausing = DeviceSettingsRepo.of({
        ...real,
        set: (key, value) =>
          Effect.andThen(
            real.set(key, value),
            key === BIRTHDAY_REMINDER_OVERRIDES_KEY
              ? Effect.andThen(
                  Deferred.succeed(rewritten, undefined),
                  Effect.repeat(Effect.yieldNow, { times: 20 }),
                )
              : Effect.void,
          ),
      });
      yield* Effect.all(
        [
          writeBirthdayReminderSettings({ enabled: true, reminders: [at(0, '07:00')] }),
          Deferred.await(rewritten).pipe(
            Effect.andThen(
              writeBirthdayReminderSettings({ enabled: true, reminders: [at(0, '08:00')] }),
            ),
          ),
        ],
        { concurrency: 'unbounded' },
      ).pipe(Effect.provideService(DeviceSettingsRepo, pausing));
      expect(yield* readBirthdayReminderSettings).toEqual({
        enabled: true,
        reminders: [at(0, '08:00')],
      });
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('also stores the old fields, so an older app on this database still reads them', () =>
    Effect.gen(function* () {
      const repo = yield* DeviceSettingsRepo;
      yield* writeBirthdayReminderSettings({
        enabled: true,
        reminders: [at(3, '18:00'), at(1, '07:00')],
      });
      expect(yield* repo.get(BIRTHDAY_REMINDERS_KEY)).toEqual({
        enabled: true,
        leadDays: [1, 3],
        reminders: [at(1, '07:00'), at(3, '18:00')],
        time: '07:00',
      });
      yield* writeBirthdayReminderOverrides([
        { day: 4, displayName: 'Alice', month: 3, reminders: [at(14, '19:00'), at(0)] },
        { day: 10, displayName: 'Bob', month: 3, reminders: [] },
      ]);
      expect(yield* repo.get(BIRTHDAY_REMINDER_OVERRIDES_KEY)).toEqual([
        {
          day: 4,
          displayName: 'Alice',
          leadDays: [0, 14],
          month: 3,
          reminders: [at(0), at(14, '19:00')],
        },
        { day: 10, displayName: 'Bob', leadDays: [], month: 3, reminders: [] },
      ]);
      // The schema before each reminder had its own time reads both.
      const OldSettings = Schema.Struct({
        enabled: Schema.Boolean,
        leadDays: Schema.Array(Schema.Number),
        time: Schema.String,
      });
      const OldOverride = Schema.Struct({
        day: Schema.Number,
        displayName: Schema.String,
        leadDays: Schema.Array(Schema.Number),
        month: Schema.Number,
      });
      expect(
        yield* Schema.decodeUnknownEffect(OldSettings)(yield* repo.get(BIRTHDAY_REMINDERS_KEY)),
      ).toEqual({ enabled: true, leadDays: [1, 3], time: '07:00' });
      expect(
        yield* Schema.decodeUnknownEffect(Schema.Array(OldOverride))(
          yield* repo.get(BIRTHDAY_REMINDER_OVERRIDES_KEY),
        ),
      ).toEqual([
        { day: 4, displayName: 'Alice', leadDays: [0, 14], month: 3 },
        { day: 10, displayName: 'Bob', leadDays: [], month: 3 },
      ]);
      // And today's reads ignore them.
      expect(yield* readBirthdayReminderSettings).toEqual({
        enabled: true,
        reminders: [at(1, '07:00'), at(3, '18:00')],
      });
      expect(yield* readBirthdayReminderOverrides).toEqual([
        { day: 4, displayName: 'Alice', month: 3, reminders: [at(0), at(14, '19:00')] },
        { day: 10, displayName: 'Bob', month: 3, reminders: [] },
      ]);
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('a save creates no per-person list where there was none', () =>
    Effect.gen(function* () {
      const repo = yield* DeviceSettingsRepo;
      yield* repo.set(BIRTHDAY_REMINDERS_KEY, { enabled: true, leadDays: [0], time: '18:30' });
      yield* writeBirthdayReminderSettings({ enabled: false, reminders: [at(0)] });
      expect(yield* repo.get(BIRTHDAY_REMINDER_OVERRIDES_KEY)).toBe(null);
    }).pipe(Effect.provide(dbLayer())),
  );
});

describe('birthday reminder overrides', () => {
  it.effect('empty when nothing is stored, round-trips one canonical entry per person', () =>
    Effect.gen(function* () {
      expect(yield* readBirthdayReminderOverrides).toEqual([]);
      yield* writeBirthdayReminderOverrides([
        { day: 10, displayName: 'Bob', month: 3, reminders: [at(7), at(0), at(7, '20:00')] },
        { day: 4, displayName: 'Alice', month: 3, reminders: [at(1)] },
        { day: 4, displayName: 'alice', month: 3, reminders: [at(14)] },
      ]);
      expect(yield* readBirthdayReminderOverrides).toEqual([
        { day: 4, displayName: 'alice', month: 3, reminders: [at(14)] },
        { day: 10, displayName: 'Bob', month: 3, reminders: [at(0), at(7, '20:00')] },
      ]);
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('an entry that no longer decodes is skipped, the others survive', () =>
    Effect.gen(function* () {
      yield* (yield* DeviceSettingsRepo).set(BIRTHDAY_REMINDER_OVERRIDES_KEY, [
        { day: 4, displayName: 'Alice', month: 3, reminders: [{ leadDays: 5, time: '09:00' }] },
        { day: 10, displayName: 'Bob', month: 3, reminders: [at(14)] },
      ]);
      expect(yield* readBirthdayReminderOverrides).toEqual([
        { day: 10, displayName: 'Bob', month: 3, reminders: [at(14)] },
      ]);
      yield* (yield* DeviceSettingsRepo).set(BIRTHDAY_REMINDER_OVERRIDES_KEY, { not: 'a list' });
      expect(yield* readBirthdayReminderOverrides).toEqual([]);
    }).pipe(Effect.provide(dbLayer())),
  );
});

describe('view preferences', () => {
  it.effect('defaults to an expanded lane and round-trips a collapse', () =>
    Effect.gen(function* () {
      expect(yield* readViewPreferences).toEqual(DEFAULT_VIEW_PREFERENCES);
      yield* writeViewPreferences({ allDayLaneCollapsed: true });
      expect(yield* readViewPreferences).toEqual({ allDayLaneCollapsed: true });
      // The device-local fields round-trip too, and only when set.
      yield* writeViewPreferences({
        allDayLaneCollapsed: false,
        lastView: 'agenda',
        sidebarCollapsed: true,
      });
      expect(yield* readViewPreferences).toEqual({
        allDayLaneCollapsed: false,
        lastView: 'agenda',
        sidebarCollapsed: true,
      });
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('a stored value that no longer decodes reads as the defaults', () =>
    Effect.gen(function* () {
      yield* (yield* DeviceSettingsRepo).set(VIEW_PREFERENCES_KEY, { allDayLaneCollapsed: 'yes' });
      expect(yield* readViewPreferences).toEqual(DEFAULT_VIEW_PREFERENCES);
    }).pipe(Effect.provide(dbLayer())),
  );
});

describe('time zone settings', () => {
  it.effect('defaults to the device entry alone, which reads as the zone the device is in', () =>
    Effect.gen(function* () {
      expect(yield* readTimeZoneSettings).toEqual(DEFAULT_TIME_ZONE_SETTINGS);
      expect(yield* readPrimaryTimeZone).toBe(Temporal.Now.timeZoneId());
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('round-trips the list in the stored order, the device entry unresolved', () =>
    Effect.gen(function* () {
      yield* writeTimeZoneSettings({
        primary: 'Asia/Kolkata',
        zones: ['Europe/Vienna', 'device', 'Asia/Kolkata'],
      });
      expect(yield* readTimeZoneSettings).toEqual({
        primary: 'Asia/Kolkata',
        zones: ['Europe/Vienna', 'device', 'Asia/Kolkata'],
      });
      expect(yield* readPrimaryTimeZone).toBe('Asia/Kolkata');
      yield* writeTimeZoneSettings({ primary: 'device', zones: ['device', 'Asia/Kolkata'] });
      expect(yield* readPrimaryTimeZone).toBe(Temporal.Now.timeZoneId());
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('an undecodable or stale value reads as the default', () =>
    Effect.gen(function* () {
      const repo = yield* DeviceSettingsRepo;
      yield* repo.set(TIME_ZONES_KEY, { primary: 'x' });
      expect(yield* readTimeZoneSettings).toEqual(DEFAULT_TIME_ZONE_SETTINGS);
      // A zone tzdata dropped must not reach the grid.
      yield* repo.set(TIME_ZONES_KEY, { primary: 'device', zones: ['device', 'Mars/Olympus'] });
      expect(yield* readTimeZoneSettings).toEqual(DEFAULT_TIME_ZONE_SETTINGS);
      // A list without the device entry is not patched here.
      yield* repo.set(TIME_ZONES_KEY, { primary: 'UTC', zones: ['UTC'] });
      expect(yield* readTimeZoneSettings).toEqual(DEFAULT_TIME_ZONE_SETTINGS);
    }).pipe(Effect.provide(dbLayer())),
  );
});

describe('onboarding state', () => {
  it.effect('defaults to the setup due and the card open; round-trips the canonical shape', () =>
    Effect.gen(function* () {
      expect(yield* readOnboarding).toEqual(DEFAULT_ONBOARDING_STATE);
      yield* writeOnboarding({
        card: 'collapsed',
        lessons: { alerts: undefined, create: 'skipped', zones: 'done' },
        setup: 'done',
      });
      expect(yield* readOnboarding).toEqual({
        card: 'collapsed',
        lessons: { create: 'skipped', zones: 'done' },
        setup: 'done',
      });
      expect(yield* (yield* DeviceSettingsRepo).get(ONBOARDING_KEY)).toEqual({
        card: 'collapsed',
        lessons: { create: 'skipped', zones: 'done' },
        setup: 'done',
      });
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('a stored value that no longer decodes reads as the default', () =>
    Effect.gen(function* () {
      yield* (yield* DeviceSettingsRepo).set(ONBOARDING_KEY, { card: 'open', lessons: {} });
      expect(yield* readOnboarding).toEqual(DEFAULT_ONBOARDING_STATE);
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('changes land on what is stored, every one of them when sent together', () =>
    Effect.gen(function* () {
      yield* writeOnboarding({ card: 'expanded', lessons: { create: 'done' }, setup: 'done' });
      // A read that yields before it answers, as a real database's does:
      // without one change at a time, each would write back what it read
      // before the others' changes landed.
      const repo = yield* DeviceSettingsRepo;
      const yielding = DeviceSettingsRepo.of({
        ...repo,
        get: (key) => Effect.tap(repo.get(key), () => Effect.yieldNow),
      });
      yield* Effect.all(
        [
          updateOnboarding({ lesson: { id: 'alerts', mark: 'skipped' } }),
          updateOnboarding({ lesson: { id: 'search', mark: 'done' } }),
          updateOnboarding({ card: 'collapsed' }),
          updateOnboarding({ lesson: { id: 'create', mark: 'skipped' } }),
        ],
        { concurrency: 'unbounded' },
      ).pipe(Effect.provideService(DeviceSettingsRepo, yielding));
      expect(yield* readOnboarding).toEqual({
        card: 'collapsed',
        lessons: { alerts: 'skipped', create: 'done', search: 'done' },
        setup: 'done',
      });
      yield* updateOnboarding({ reset: 'lessons' });
      expect(yield* readOnboarding).toEqual({ card: 'expanded', lessons: {}, setup: 'done' });
    }).pipe(Effect.provide(dbLayer())),
  );
});
