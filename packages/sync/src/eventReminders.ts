import { MAX_REMINDER_MINUTES, planEventReminders, type PlannedNotification } from '@calendar/core';
import { CalendarRepo, type DeviceSettingsRepo, type EventRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import type { AppleCalendarEvents } from './appleCalendarEvents.ts';
import { readEventNotificationSettings } from './deviceSettings.ts';
import { loadEventsInRange } from './eventsInRange.ts';

const MINUTE_MS = 60_000;
/** A reminder an immediate sink can still catch up on after sleep. */
const LOOKBACK_MS = 12 * 60 * MINUTE_MS;
/** How far ahead event reminders are planned — a week fills iOS's schedule anyway. */
const HORIZON_MS = 7 * 24 * 60 * MINUTE_MS;

/**
 * The event-reminder producer for LocalNotifications: every popup
 * reminder due in the next week for the events on visible calendars.
 * Events are read past the horizon by the longest possible offset, so a
 * "one week before" reminder of an event in ten days is planned today.
 * Disabled settings yield nothing — never touch the birthday plans.
 */
export const loadEventPlans = (
  now: number,
  deviceTimeZone: string,
): Effect.Effect<
  ReadonlyArray<PlannedNotification>,
  SqlError,
  AppleCalendarEvents | CalendarRepo | DeviceSettingsRepo | EventRepo
> =>
  Effect.gen(function* () {
    const settings = yield* readEventNotificationSettings;
    if (!settings.enabled) {
      return [];
    }
    const from = now - LOOKBACK_MS;
    const until = now + HORIZON_MS;
    const events = yield* loadEventsInRange(from, until + MAX_REMINDER_MINUTES * MINUTE_MS, {
      apple: settings.includeAppleCalendar,
    });
    const calendars = yield* (yield* CalendarRepo).list();
    return planEventReminders(events, {
      calendars,
      deviceTimeZone,
      from,
      includeApple: settings.includeAppleCalendar,
      until,
    });
  });
