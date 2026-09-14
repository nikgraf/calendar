import { DEFAULT_BIRTHDAY_REMINDER_SETTINGS } from '@calendar/core';
import { DeviceSettingsRepo, reposLayer, runMigrations } from '@calendar/db';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import {
  BIRTHDAY_REMINDERS_KEY,
  readBirthdayReminderSettings,
  writeBirthdayReminderSettings,
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
