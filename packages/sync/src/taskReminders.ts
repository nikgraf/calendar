import { type PlannedNotification, planTaskReminders, toZonedDateTime } from '@calendar/core';
import { type DeviceSettingsRepo, TaskRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { readTaskNotificationSettings } from './deviceSettings.ts';

/** How far ahead task reminders are planned — a week, like event reminders. */
const HORIZON_DAYS = 7;

/**
 * The task-reminder producer for LocalNotifications: the open tasks on
 * visible lists due today through a week ahead, days on the device's
 * clock (a task's due day is a wall-clock date). Nothing earlier: a task
 * due yesterday expired at midnight, so no sink would show it. Disabled
 * settings yield nothing — never touch the other producers' plans.
 */
export const loadTaskPlans = (
  now: number,
  timeZone: string,
): Effect.Effect<ReadonlyArray<PlannedNotification>, SqlError, DeviceSettingsRepo | TaskRepo> =>
  Effect.gen(function* () {
    const settings = yield* readTaskNotificationSettings;
    if (!settings.enabled) {
      return [];
    }
    const today = toZonedDateTime(now, timeZone).toPlainDate();
    const fromDate = today.toString();
    const untilDate = today.add({ days: HORIZON_DAYS }).toString();
    const taskRepo = yield* TaskRepo;
    const tasks = yield* taskRepo.getWindow(fromDate, untilDate);
    const lists = (yield* taskRepo.listLists()).filter((list) => list.isVisible);
    return planTaskReminders(tasks, settings, { fromDate, lists, timeZone, untilDate });
  });
