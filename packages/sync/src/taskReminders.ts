import { type PlannedNotification, planTaskReminders, toZonedDateTime } from '@calendar/core';
import { DeviceSettingsRepo, PendingOpRepo, TaskRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { readTaskNotificationSettings, TASK_NOTIFICATIONS_KEY } from './deviceSettings.ts';

/** How far ahead task reminders are planned — a week, like event reminders. */
const HORIZON_DAYS = 7;
/**
 * When this device first planned task notifications: stands in for the
 * settings row's stamp while nothing has been saved, so a Mac updated to
 * this build in the afternoon does not show every task already due today.
 */
const TASKS_SINCE_KEY = 'localNotifications.tasksSince';

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
): Effect.Effect<
  ReadonlyArray<PlannedNotification>,
  SqlError,
  DeviceSettingsRepo | PendingOpRepo | TaskRepo
> =>
  Effect.gen(function* () {
    const settings = yield* readTaskNotificationSettings;
    if (!settings.enabled) {
      return [];
    }
    const today = toZonedDateTime(now, timeZone).toPlainDate();
    const fromDate = today.toString();
    const untilDate = today.add({ days: HORIZON_DAYS }).toString();
    const settingsRepo = yield* DeviceSettingsRepo;
    const firstPlannedAt = yield* settingsRepo.get(TASKS_SINCE_KEY);
    if (typeof firstPlannedAt !== 'number') {
      yield* settingsRepo.set(TASKS_SINCE_KEY, now);
    }
    const since =
      (yield* settingsRepo.updatedAt(TASK_NOTIFICATIONS_KEY)) ??
      (typeof firstPlannedAt === 'number' ? firstPlannedAt : now);
    const taskRepo = yield* TaskRepo;
    // A day wider each side: a reminder with an instant of its own is
    // planned on that instant's day here, which the stored day — written
    // in the zone the device was in when the row was read — can miss by one.
    const tasks = yield* taskRepo.getWindow(
      today.subtract({ days: 1 }).toString(),
      today.add({ days: HORIZON_DAYS + 1 }).toString(),
    );
    const lists = (yield* taskRepo.listLists()).filter((list) => list.isVisible);
    // A queued task op dates the local edit the row carries under the
    // server's older stamp.
    const localEdits = new Map<string, number>();
    for (const op of yield* (yield* PendingOpRepo).listAll()) {
      if (op.taskListId !== undefined) {
        const key = `${op.accountId}/${op.eventId}`;
        localEdits.set(key, Math.max(localEdits.get(key) ?? 0, op.createdAt));
      }
    }
    return planTaskReminders(tasks, settings, {
      fromDate,
      lists,
      localEdits,
      since,
      timeZone,
      untilDate,
    });
  });
