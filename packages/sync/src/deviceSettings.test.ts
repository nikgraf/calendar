import {
  DEFAULT_BIRTHDAY_REMINDER_SETTINGS,
  DEFAULT_VIEW_PREFERENCES,
  isValidTimeZone,
} from '@calendar/core';
import { DeviceSettingsRepo, reposLayer, runMigrations } from '@calendar/db';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { describe } from 'vite-plus/test';
import {
  BIRTHDAY_REMINDER_OVERRIDES_KEY,
  BIRTHDAY_REMINDERS_KEY,
  readBirthdayReminderOverrides,
  readBirthdayReminderSettings,
  readTimeZoneSettings,
  readViewPreferences,
  TIME_ZONES_KEY,
  VIEW_PREFERENCES_KEY,
  writeBirthdayReminderOverrides,
  writeBirthdayReminderSettings,
  writeTimeZoneSettings,
  writeViewPreferences,
} from './deviceSettings.ts';

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
      yield* writeBirthdayReminderSettings({ enabled: true, leadDays: [7, 0, 7], time: '18:30' });
      expect(yield* readBirthdayReminderSettings).toEqual({
        enabled: true,
        leadDays: [0, 7],
        time: '18:30',
      });
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('a stored value that no longer decodes reads as the defaults', () =>
    Effect.gen(function* () {
      yield* (yield* DeviceSettingsRepo).set(BIRTHDAY_REMINDERS_KEY, { leadDays: [5] });
      expect(yield* readBirthdayReminderSettings).toEqual(DEFAULT_BIRTHDAY_REMINDER_SETTINGS);
    }).pipe(Effect.provide(dbLayer())),
  );
});

describe('birthday reminder overrides', () => {
  it.effect('empty when nothing is stored, round-trips one canonical entry per person', () =>
    Effect.gen(function* () {
      expect(yield* readBirthdayReminderOverrides).toEqual([]);
      yield* writeBirthdayReminderOverrides([
        { day: 10, displayName: 'Bob', leadDays: [7, 0, 7], month: 3 },
        { day: 4, displayName: 'Alice', leadDays: [1], month: 3 },
        { day: 4, displayName: 'alice', leadDays: [14], month: 3 },
      ]);
      expect(yield* (yield* DeviceSettingsRepo).get(BIRTHDAY_REMINDER_OVERRIDES_KEY)).toEqual([
        { day: 4, displayName: 'alice', leadDays: [14], month: 3 },
        { day: 10, displayName: 'Bob', leadDays: [0, 7], month: 3 },
      ]);
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('an entry that no longer decodes is skipped, the others survive', () =>
    Effect.gen(function* () {
      yield* (yield* DeviceSettingsRepo).set(BIRTHDAY_REMINDER_OVERRIDES_KEY, [
        { day: 4, displayName: 'Alice', leadDays: [5], month: 3 },
        { day: 10, displayName: 'Bob', leadDays: [14], month: 3 },
      ]);
      expect(yield* readBirthdayReminderOverrides).toEqual([
        { day: 10, displayName: 'Bob', leadDays: [14], month: 3 },
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
  it.effect('defaults to a single valid zone that is the primary', () =>
    Effect.gen(function* () {
      const settings = yield* readTimeZoneSettings;
      expect(settings.zones).toHaveLength(1);
      expect(settings.primary).toBe(settings.zones[0]);
      expect(isValidTimeZone(settings.primary)).toBe(true);
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('round-trips the list in the stored order', () =>
    Effect.gen(function* () {
      yield* writeTimeZoneSettings({
        primary: 'Asia/Kolkata',
        zones: ['Europe/Vienna', 'Asia/Kolkata'],
      });
      expect(yield* readTimeZoneSettings).toEqual({
        primary: 'Asia/Kolkata',
        zones: ['Europe/Vienna', 'Asia/Kolkata'],
      });
    }).pipe(Effect.provide(dbLayer())),
  );

  it.effect('an undecodable or stale value reads as the default', () =>
    Effect.gen(function* () {
      const repo = yield* DeviceSettingsRepo;
      yield* repo.set(TIME_ZONES_KEY, { primary: 'x' });
      const fallback = yield* readTimeZoneSettings;
      expect(fallback.zones).toHaveLength(1);
      // A zone tzdata dropped must not reach the grid.
      yield* repo.set(TIME_ZONES_KEY, { primary: 'Mars/Olympus', zones: ['Mars/Olympus'] });
      expect(yield* readTimeZoneSettings).toEqual(fallback);
    }).pipe(Effect.provide(dbLayer())),
  );
});
