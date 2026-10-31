import {
  type BirthdayReminder,
  type BirthdayReminderSettings,
  type EventNotificationSettings,
  mergeEventNotificationSettings,
  mergeTaskNotificationSettings,
  type TaskNotificationSettings,
  type TimeZoneSettings,
  withBirthdayOverride,
} from '@calendar/core';
import type { DeviceSettingsRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import {
  readBirthdayReminderSettings,
  readEventNotificationSettings,
  readTaskNotificationSettings,
  updateBirthdayReminderOverrides,
  writeBirthdayReminderSettings,
  writeEventNotificationSettings,
  writeTaskNotificationSettings,
  writeTimeZoneSettings,
} from './deviceSettings.ts';
import { LocalNotifications } from './localNotifications.ts';
import { NotificationSink } from './notificationSink.ts';

export interface NotificationSettingsResult {
  readonly notificationsGranted: boolean;
}

type NotificationSettingsServices = DeviceSettingsRepo | LocalNotifications | NotificationSink;

/**
 * Saves, asks the OS for notification permission, and runs a reminder pass
 * right away so the schedule reflects the new choice. A scheduled sink
 * (iOS) asks on every enabled save — a no-op once granted, and it brings
 * the notice back after a later denial. An immediate sink (desktop) can
 * only find out by posting a banner, so it asks once, as reminders turn
 * on. Shared by the settings rpcs and the settings import so a file never
 * bypasses the prompt or the reschedule.
 */
const applyWithPermission = (
  enabled: boolean,
  wasEnabled: boolean,
): Effect.Effect<NotificationSettingsResult, never, LocalNotifications | NotificationSink> =>
  Effect.gen(function* () {
    const sink = yield* NotificationSink;
    const ask = enabled && (sink.kind === 'scheduled' || !wasEnabled);
    const notificationsGranted = ask ? yield* sink.ensurePermission() : true;
    yield* Effect.forkDetach((yield* LocalNotifications).run());
    return { notificationsGranted };
  });

export const applyBirthdayReminderSettings = (
  settings: BirthdayReminderSettings,
): Effect.Effect<NotificationSettingsResult, SqlError, NotificationSettingsServices> =>
  Effect.gen(function* () {
    const previous = yield* readBirthdayReminderSettings;
    yield* writeBirthdayReminderSettings(settings);
    return yield* applyWithPermission(settings.enabled, previous.enabled);
  });

export interface BirthdayReminderOverrideInput {
  readonly day: number;
  readonly displayName: string;
  readonly month: number;
  /** `null` returns the person to the general reminders. */
  readonly reminders: ReadonlyArray<BirthdayReminder> | null;
}

/**
 * Saves one person's reminders and re-plans right away: LocalNotifications
 * only listens for birthday and event changes, so a settings write would
 * otherwise wait for the next minute's pass. No permission prompt — an
 * override never turns the reminders on.
 */
export const applyBirthdayReminderOverride = (
  input: BirthdayReminderOverrideInput,
): Effect.Effect<void, SqlError, DeviceSettingsRepo | LocalNotifications> =>
  Effect.gen(function* () {
    yield* updateBirthdayReminderOverrides((overrides) =>
      withBirthdayOverride(overrides, input, input.reminders),
    );
    yield* Effect.forkDetach((yield* LocalNotifications).run());
  });

export const applyEventNotificationSettings = (
  settings: EventNotificationSettings,
): Effect.Effect<NotificationSettingsResult, SqlError, NotificationSettingsServices> =>
  Effect.gen(function* () {
    const previous = yield* readEventNotificationSettings;
    // A field the caller leaves out (an older file or client) keeps its value.
    yield* writeEventNotificationSettings(mergeEventNotificationSettings(previous, settings));
    return yield* applyWithPermission(settings.enabled, previous.enabled);
  });

export const applyTaskNotificationSettings = (
  settings: TaskNotificationSettings,
): Effect.Effect<NotificationSettingsResult, SqlError, NotificationSettingsServices> =>
  Effect.gen(function* () {
    const previous = yield* readTaskNotificationSettings;
    // A switch the caller leaves out (an older file or client) keeps its value.
    yield* writeTaskNotificationSettings(mergeTaskNotificationSettings(previous, settings));
    return yield* applyWithPermission(settings.enabled, previous.enabled);
  });

/**
 * Saves the time zones and re-plans right away: an event reminder names
 * the start in the primary zone too, and a scheduled sink (iOS) still
 * holds the text planned under the old one.
 */
export const applyTimeZoneSettings = (
  settings: TimeZoneSettings,
): Effect.Effect<void, SqlError, DeviceSettingsRepo | LocalNotifications> =>
  Effect.gen(function* () {
    yield* writeTimeZoneSettings(settings);
    yield* Effect.forkDetach((yield* LocalNotifications).run());
  });
