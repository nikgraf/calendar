import type { BirthdayReminderSettings, EventNotificationSettings } from '@calendar/core';
import type { DeviceSettingsRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import {
  readBirthdayReminderSettings,
  readEventNotificationSettings,
  writeBirthdayReminderSettings,
  writeEventNotificationSettings,
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

export const applyEventNotificationSettings = (
  settings: EventNotificationSettings,
): Effect.Effect<NotificationSettingsResult, SqlError, NotificationSettingsServices> =>
  Effect.gen(function* () {
    const previous = yield* readEventNotificationSettings;
    yield* writeEventNotificationSettings(settings);
    return yield* applyWithPermission(settings.enabled, previous.enabled);
  });
