import {
  BirthdayReminderSettings,
  DEFAULT_BIRTHDAY_REMINDER_SETTINGS,
  DEFAULT_VIEW_PREFERENCES,
  ViewPreferences,
} from '@calendar/core';
import { DeviceSettingsRepo } from '@calendar/db';
import { Effect, Schema } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';

/** The device_settings key for birthday reminders. */
export const BIRTHDAY_REMINDERS_KEY = 'birthdayReminders';

const decodeSettings = Schema.decodeUnknownEffect(BirthdayReminderSettings);

/** The stored preferences, or the defaults when nothing (or nothing decodable) is stored. */
export const readBirthdayReminderSettings: Effect.Effect<
  BirthdayReminderSettings,
  SqlError,
  DeviceSettingsRepo
> = Effect.gen(function* () {
  const raw = yield* (yield* DeviceSettingsRepo).get(BIRTHDAY_REMINDERS_KEY);
  if (raw === null) {
    return DEFAULT_BIRTHDAY_REMINDER_SETTINGS;
  }
  return yield* decodeSettings(raw).pipe(
    Effect.orElseSucceed(() => DEFAULT_BIRTHDAY_REMINDER_SETTINGS),
  );
});

export const writeBirthdayReminderSettings = (
  settings: BirthdayReminderSettings,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.flatMap(DeviceSettingsRepo, (repo) =>
    repo.set(BIRTHDAY_REMINDERS_KEY, {
      enabled: settings.enabled,
      // Deduped and ordered so the stored value is canonical.
      leadDays: [...new Set(settings.leadDays)].sort((a, b) => a - b),
      time: settings.time,
    }),
  );

/** The device_settings key for view preferences. */
export const VIEW_PREFERENCES_KEY = 'viewPreferences';

const decodeViewPreferences = Schema.decodeUnknownEffect(ViewPreferences);

/** The stored view preferences, or the defaults when nothing (or nothing decodable) is stored. */
export const readViewPreferences: Effect.Effect<ViewPreferences, SqlError, DeviceSettingsRepo> =
  Effect.gen(function* () {
    const raw = yield* (yield* DeviceSettingsRepo).get(VIEW_PREFERENCES_KEY);
    if (raw === null) {
      return DEFAULT_VIEW_PREFERENCES;
    }
    return yield* decodeViewPreferences(raw).pipe(
      Effect.orElseSucceed(() => DEFAULT_VIEW_PREFERENCES),
    );
  });

export const writeViewPreferences = (
  preferences: ViewPreferences,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.flatMap(DeviceSettingsRepo, (repo) =>
    repo.set(VIEW_PREFERENCES_KEY, { allDayLaneCollapsed: preferences.allDayLaneCollapsed }),
  );
