import {
  applyOnboardingChange,
  type BirthdayReminder,
  BirthdayReminderOverride,
  type BirthdayReminderOverrides,
  BirthdayReminderSettings,
  canonicalBirthdayOverrides,
  canonicalBirthdayReminders,
  canonicalOnboardingState,
  DEFAULT_BIRTHDAY_REMINDER_SETTINGS,
  DEFAULT_BIRTHDAY_REMINDER_TIME,
  DEFAULT_EVENT_NOTIFICATION_SETTINGS,
  DEFAULT_ONBOARDING_STATE,
  DEFAULT_TIME_ZONE_SETTINGS,
  DEFAULT_VIEW_PREFERENCES,
  EventNotificationSettings,
  mergeEventNotificationSettings,
  type OnboardingChange,
  OnboardingState,
  resolveTimeZones,
  sortWeekdays,
  Temporal,
  TimeZoneSettings,
  upgradeBirthdayReminderData,
  ViewPreferences,
} from '@calendar/core';
import { DeviceSettingsRepo } from '@calendar/db';
import { Effect, Schema, Semaphore } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

/** The device_settings key for birthday reminders. */
export const BIRTHDAY_REMINDERS_KEY = 'birthdayReminders';

const decodeSettings = Schema.decodeUnknownEffect(BirthdayReminderSettings);

/** The device_settings key for per-person birthday reminders. */
export const BIRTHDAY_REMINDER_OVERRIDES_KEY = 'birthdayReminderOverrides';

/**
 * Both birthday keys as stored, in today's shape: a device that saved
 * them before each reminder had its own time reads every lead at the one
 * time it had then (`upgradeBirthdayReminderData`). `staleOverrides`
 * says per-person entries are still in that shape, timed from the
 * general settings as they are now.
 */
const readStoredBirthdays = Effect.gen(function* () {
  const repo = yield* DeviceSettingsRepo;
  const settings = yield* repo.get(BIRTHDAY_REMINDERS_KEY);
  const overrides = yield* repo.get(BIRTHDAY_REMINDER_OVERRIDES_KEY);
  const upgraded = upgradeBirthdayReminderData({ overrides, settings });
  const staleOverrides =
    Array.isArray(overrides) &&
    Array.isArray(upgraded.overrides) &&
    upgraded.overrides.some((entry, index) => entry !== overrides[index]);
  return { ...upgraded, staleOverrides };
});

/** The stored preferences, or the defaults when nothing (or nothing decodable) is stored. */
export const readBirthdayReminderSettings: Effect.Effect<
  BirthdayReminderSettings,
  SqlError,
  DeviceSettingsRepo
> = Effect.gen(function* () {
  const { settings } = yield* readStoredBirthdays;
  if (settings === null) {
    return DEFAULT_BIRTHDAY_REMINDER_SETTINGS;
  }
  return yield* decodeSettings(settings).pipe(
    Effect.map((decoded) => ({
      enabled: decoded.enabled,
      reminders: canonicalBirthdayReminders(decoded.reminders),
    })),
    Effect.orElseSucceed(() => DEFAULT_BIRTHDAY_REMINDER_SETTINGS),
  );
});

/**
 * The lead days alone, beside `reminders` in what is stored: an older
 * app reading this database (a PR Preview loaded on the iPhone and rolled
 * back, a downgrade) requires `leadDays` (and `time`) and would read
 * reminders off and drop every person on its next save. It ignores
 * `reminders`, and this app ignores these; they can go once no installed
 * app predates `reminders`.
 */
const legacyLeadDays = (reminders: ReadonlyArray<BirthdayReminder>) =>
  reminders.map((reminder) => reminder.leadDays);

const settingsLock = Semaphore.makeUnsafe(1);

/**
 * Saves the general preferences, one save at a time so they land in the
 * order they were made. The first save over the old shape takes its
 * shared time with it, so per-person entries still in that shape are
 * rewritten first, at that time: a later change to the general reminders
 * must not move them.
 */
export const writeBirthdayReminderSettings = (
  settings: BirthdayReminderSettings,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  settingsLock.withPermits(1)(
    Effect.gen(function* () {
      if ((yield* readStoredBirthdays).staleOverrides) {
        yield* updateBirthdayReminderOverrides((current) => current);
      }
      // One per lead, ordered, so the stored value is canonical.
      const reminders = canonicalBirthdayReminders(settings.reminders);
      yield* (yield* DeviceSettingsRepo).set(BIRTHDAY_REMINDERS_KEY, {
        enabled: settings.enabled,
        leadDays: legacyLeadDays(reminders),
        reminders,
        time: reminders[0]?.time ?? DEFAULT_BIRTHDAY_REMINDER_TIME,
      });
    }),
  );

const decodeOverride = Schema.decodeUnknownEffect(BirthdayReminderOverride);

/**
 * The stored per-person reminders. An entry that no longer decodes (a
 * hand edit in the settings file) is skipped rather than taking the
 * others with it.
 */
export const readBirthdayReminderOverrides: Effect.Effect<
  BirthdayReminderOverrides,
  SqlError,
  DeviceSettingsRepo
> = Effect.gen(function* () {
  const raw = (yield* readStoredBirthdays).overrides;
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
    repo.set(
      BIRTHDAY_REMINDER_OVERRIDES_KEY,
      canonicalBirthdayOverrides(overrides).map((override) => ({
        day: override.day,
        displayName: override.displayName,
        leadDays: legacyLeadDays(override.reminders),
        month: override.month,
        reminders: override.reminders,
      })),
    ),
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

/**
 * The stored preferences, or the defaults (on) when nothing decodable is
 * stored. `dismissWhenOver` only once someone set it (absent reads as on).
 */
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
    Effect.map((stored) =>
      mergeEventNotificationSettings(DEFAULT_EVENT_NOTIFICATION_SETTINGS, stored),
    ),
    Effect.orElseSucceed(() => DEFAULT_EVENT_NOTIFICATION_SETTINGS),
  );
});

export const writeEventNotificationSettings = (
  settings: EventNotificationSettings,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.flatMap(DeviceSettingsRepo, (repo) =>
    repo.set(EVENT_NOTIFICATIONS_KEY, {
      ...(settings.dismissWhenOver === undefined
        ? {}
        : { dismissWhenOver: settings.dismissWhenOver }),
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
    repo.set(VIEW_PREFERENCES_KEY, {
      allDayLaneCollapsed: preferences.allDayLaneCollapsed,
      ...(preferences.lastView === undefined ? {} : { lastView: preferences.lastView }),
      ...(preferences.sidebarCollapsed === undefined
        ? {}
        : { sidebarCollapsed: preferences.sidebarCollapsed }),
      ...(preferences.weekendDays === undefined
        ? {}
        : { weekendDays: sortWeekdays(preferences.weekendDays) }),
      ...(preferences.weekendShading === undefined
        ? {}
        : { weekendShading: preferences.weekendShading }),
    }),
  );

/**
 * The device_settings key for the first run and the Getting started
 * card. Per device, like the view preferences: not in the settings
 * document, and not one of the keys that write the settings file back.
 */
export const ONBOARDING_KEY = 'onboarding';

const decodeOnboarding = Schema.decodeUnknownEffect(OnboardingState);

/** The stored onboarding state, or the default (the setup due, the card open) when nothing decodable is stored. */
export const readOnboarding: Effect.Effect<OnboardingState, SqlError, DeviceSettingsRepo> =
  Effect.gen(function* () {
    const raw = yield* (yield* DeviceSettingsRepo).get(ONBOARDING_KEY);
    if (raw === null) {
      return DEFAULT_ONBOARDING_STATE;
    }
    return yield* decodeOnboarding(raw).pipe(Effect.orElseSucceed(() => DEFAULT_ONBOARDING_STATE));
  });

export const writeOnboarding = (
  state: OnboardingState,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.flatMap(DeviceSettingsRepo, (repo) =>
    // Canonical: only the marks that are set, in card order.
    repo.set(ONBOARDING_KEY, canonicalOnboardingState(state)),
  );

const onboardingLock = Semaphore.makeUnsafe(1);

/**
 * Read-modify-write of the onboarding state, one change at a time: every
 * window's change lands on the one before it, whatever each window last
 * read (a lesson ticked skipped as its frame closes, the next one ticked
 * done a moment later).
 */
export const updateOnboarding = (
  change: OnboardingChange,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  onboardingLock.withPermits(1)(
    Effect.flatMap(readOnboarding, (current) =>
      writeOnboarding(applyOnboardingChange(current, change)),
    ),
  );

/** The device_settings key for the time zones. */
export const TIME_ZONES_KEY = 'timeZones';

const decodeTimeZoneSettings = Schema.decodeUnknownEffect(TimeZoneSettings);

/**
 * The stored time zones as entries (the device entry unresolved), or the
 * device entry alone when nothing (or nothing decodable) is stored — a
 * zone id tzdata no longer knows fails the schema's Temporal check and so
 * also reads as the default, never as a grid that throws.
 */
export const readTimeZoneSettings: Effect.Effect<TimeZoneSettings, SqlError, DeviceSettingsRepo> =
  Effect.gen(function* () {
    const raw = yield* (yield* DeviceSettingsRepo).get(TIME_ZONES_KEY);
    if (raw === null) {
      return DEFAULT_TIME_ZONE_SETTINGS;
    }
    return yield* decodeTimeZoneSettings(raw).pipe(
      Effect.orElseSucceed(() => DEFAULT_TIME_ZONE_SETTINGS),
    );
  });

/** The primary zone as an IANA id, the device entry read as the zone the device is in right now. */
export const readPrimaryTimeZone: Effect.Effect<string, SqlError, DeviceSettingsRepo> = Effect.map(
  readTimeZoneSettings,
  (settings) => resolveTimeZones(settings, Temporal.Now.timeZoneId()).primary,
);

export const writeTimeZoneSettings = (
  settings: TimeZoneSettings,
): Effect.Effect<void, SqlError, DeviceSettingsRepo> =>
  Effect.flatMap(DeviceSettingsRepo, (repo) =>
    repo.set(TIME_ZONES_KEY, { primary: settings.primary, zones: [...settings.zones] }),
  );
