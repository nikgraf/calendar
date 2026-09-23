import { planBirthdayReminders, type PlannedNotification, Temporal } from '@calendar/core';
import type { AccountRepo, BirthdayRepo, DeviceSettingsRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { loadMergedBirthdays } from './birthdays.ts';
import type { DeviceContacts } from './deviceContacts.ts';
import { readBirthdayReminderSettings } from './deviceSettings.ts';

/** How far ahead birthday reminders are planned (iOS schedules from this list). */
const HORIZON_DAYS = 120;

/**
 * The birthday-reminder producer for LocalNotifications: the settings'
 * lead times for every contact birthday in the next four months, at the
 * chosen time of day. Planned from yesterday so an immediate sink can
 * still catch up on last night's reminder.
 */
export const loadBirthdayPlans = (
  now: number,
  timeZone: string,
): Effect.Effect<
  ReadonlyArray<PlannedNotification>,
  SqlError,
  AccountRepo | BirthdayRepo | DeviceContacts | DeviceSettingsRepo
> =>
  Effect.gen(function* () {
    const settings = yield* readBirthdayReminderSettings;
    if (!settings.enabled) {
      return [];
    }
    const records = yield* loadMergedBirthdays;
    const fromDate = Temporal.Instant.fromEpochMilliseconds(now)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate()
      .subtract({ days: 1 })
      .toString();
    return planBirthdayReminders(records, settings, {
      fromDate,
      horizonDays: HORIZON_DAYS,
      timeZone,
    });
  });
