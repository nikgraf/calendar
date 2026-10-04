import {
  type BirthdayLeadDays,
  type BirthdayReminderSettings,
  type EventNotificationSettings,
  withBirthdayOverride,
} from '@calendar/core';
import type { DeviceSettingsRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import {
  readBirthdayReminderOverrides,
  readBirthdayReminderSettings,
  readEventNotificationSettings,
  writeBirthdayReminderOverrides,
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

export interface BirthdayReminderOverrideInput {
  readonly day: number;
  readonly displayName: string;
  /** `null` returns the person to the general lead days. */
  readonly leadDays: ReadonlyArray<BirthdayLeadDays> | null;
  readonly month: number;
}

/**
 * Saves one person's lead days and re-plans right away: LocalNotifications
 * only listens for birthday and event changes, so a settings write would
 * otherwise wait for the next minute's pass. No permission prompt — an
 * override never turns the reminders on.
 */
export const applyBirthdayReminderOverride = (
  input: BirthdayReminderOverrideInput,
): Effect.Effect<void, SqlError, DeviceSettingsRepo | LocalNotifications> =>
  Effect.gen(function* () {
    const overrides = yield* readBirthdayReminderOverrides;
    yield* writeBirthdayReminderOverrides(withBirthdayOverride(overrides, input, input.leadDays));
    yield* Effect.forkDetach((yield* LocalNotifications).run());
  });

export const applyEventNotificationSettings = (
  settings: EventNotificationSettings,
): Effect.Effect<NotificationSettingsResult, SqlError, NotificationSettingsServices> =>
  Effect.gen(function* () {
    const previous = yield* readEventNotificationSettings;
    yield* writeEventNotificationSettings(settings);
    return yield* applyWithPermission(settings.enabled, previous.enabled);
  });
