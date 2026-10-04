import {
  BirthdayReminderOverride,
  type BirthdayReminderOverrides,
  BirthdayReminderSettings,
  canonicalBirthdayOverrides,
  DEFAULT_BIRTHDAY_REMINDER_SETTINGS,
  DEFAULT_EVENT_NOTIFICATION_SETTINGS,
  DEFAULT_VIEW_PREFERENCES,
  defaultTimeZoneSettings,
  EventNotificationSettings,
  Temporal,
  TimeZoneSettings,
  ViewPreferences,
} from '@calendar/core';
import { DeviceSettingsRepo } from '@calendar/db';
import { Effect, Schema, Semaphore } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

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

/** The device_settings key for per-person birthday lead days. */
export const BIRTHDAY_REMINDER_OVERRIDES_KEY = 'birthdayReminderOverrides';

const decodeOverride = Schema.decodeUnknownEffect(BirthdayReminderOverride);

/**
 * The stored per-person lead days. An entry that no longer decodes (a
 * hand edit in the settings file) is skipped rather than taking the
 * others with it.
 */
export const readBirthdayReminderOverrides: Effect.Effect<
  BirthdayReminderOverrides,
  SqlError,
  DeviceSettingsRepo
> = Effect.gen(function* () {
  const raw = yield* (yield* DeviceSettingsRepo).get(BIRTHDAY_REMINDER_OVERRIDES_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  const overrides: Array<BirthdayReminderOverride> = [];
  for (const entry of raw) {
    const decoded = yield* decodeOverride(entry).pipe(Effect.orElseSucceed(() => undefined));
    if (decoded !== undefined) {
      overrides.push(decoded);
    }
  }
  return canonicalBirthdayOverrides(overrides);
});

export const writeBirthdayReminderOverrides = (
  overrides: BirthdayReminderOverrides,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.flatMap(DeviceSettingsRepo, (repo) =>
    // Canonical, so an unchanged set writes identical text to the settings file.
    repo.set(BIRTHDAY_REMINDER_OVERRIDES_KEY, canonicalBirthdayOverrides(overrides)),
  );

const overridesLock = Semaphore.makeUnsafe(1);

/**
 * Read-modify-write of the per-person list, one at a time. Every writer
 * that changes part of the list goes through here — a person's save, an
 * import joining a file's entries — so neither writes back a list it read
 * before the other's change landed (an import can sit on the iOS
 * permission prompt for as long as the user takes).
 */
export const updateBirthdayReminderOverrides = (
  change: (current: BirthdayReminderOverrides) => BirthdayReminderOverrides,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  overridesLock.withPermits(1)(
    Effect.flatMap(readBirthdayReminderOverrides, (current) =>
      writeBirthdayReminderOverrides(change(current)),
    ),
  );

/** The device_settings key for event notifications. */
export const EVENT_NOTIFICATIONS_KEY = 'eventNotifications';

const decodeEventNotificationSettings = Schema.decodeUnknownEffect(EventNotificationSettings);

/** The stored preferences, or the defaults (on) when nothing decodable is stored. */
export const readEventNotificationSettings: Effect.Effect<
  EventNotificationSettings,
  SqlError,
  DeviceSettingsRepo
> = Effect.gen(function* () {
  const raw = yield* (yield* DeviceSettingsRepo).get(EVENT_NOTIFICATIONS_KEY);
  if (raw === null) {
    return DEFAULT_EVENT_NOTIFICATION_SETTINGS;
  }
  return yield* decodeEventNotificationSettings(raw).pipe(
    Effect.orElseSucceed(() => DEFAULT_EVENT_NOTIFICATION_SETTINGS),
  );
});

export const writeEventNotificationSettings = (
  settings: EventNotificationSettings,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.flatMap(DeviceSettingsRepo, (repo) =>
    repo.set(EVENT_NOTIFICATIONS_KEY, {
      enabled: settings.enabled,
      includeAppleCalendar: settings.includeAppleCalendar,
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

/** The device_settings key for the time zones. */
export const TIME_ZONES_KEY = 'timeZones';

const decodeTimeZoneSettings = Schema.decodeUnknownEffect(TimeZoneSettings);

/**
 * The stored time zones, or a single device zone when nothing (or nothing
 * decodable) is stored — a zone id tzdata no longer knows fails the
 * schema's Temporal check and so also reads as the default, never as a
 * grid that throws.
 */
export const readTimeZoneSettings: Effect.Effect<TimeZoneSettings, SqlError, DeviceSettingsRepo> =
  Effect.gen(function* () {
    const raw = yield* (yield* DeviceSettingsRepo).get(TIME_ZONES_KEY);
    if (raw === null) {
      return defaultTimeZoneSettings(Temporal.Now.timeZoneId());
    }
    return yield* decodeTimeZoneSettings(raw).pipe(
      Effect.orElseSucceed(() => defaultTimeZoneSettings(Temporal.Now.timeZoneId())),
    );
  });

export const writeTimeZoneSettings = (
  settings: TimeZoneSettings,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.flatMap(DeviceSettingsRepo, (repo) =>
    repo.set(TIME_ZONES_KEY, { primary: settings.primary, zones: [...settings.zones] }),
  );
