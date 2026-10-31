import { Schema } from 'effect';
import type { TaskProvider } from '../types.ts';

/**
 * Device-local event notification preferences, stored next to the
 * birthday ones in the device_settings table and never synced.
 */
export const EventNotificationSettings = Schema.Struct({
  /**
   * iOS: a delivered reminder leaves Notification Center once its event
   * is over (`dismissAt`). Absent reads as on (`dismissesWhenOver`), and
   * absent stays absent until someone flips the switch: a device without
   * one (the Mac) stores a value only from an imported file or code, and
   * passes that on like the other two fields; it never makes one up.
   */
  dismissWhenOver: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  /**
   * Calendar.app already fires the alarms of Apple Calendar events
   * system-wide; on means Solunivo shows them too (twice, for most people).
   */
  includeAppleCalendar: Schema.Boolean,
});
export type EventNotificationSettings = typeof EventNotificationSettings.Type;

export const DEFAULT_EVENT_NOTIFICATION_SETTINGS: EventNotificationSettings = {
  enabled: true,
  includeAppleCalendar: false,
};

/** Whether delivered reminders leave once their event is over: on unless switched off. */
export const dismissesWhenOver = (
  settings: Pick<EventNotificationSettings, 'dismissWhenOver'>,
): boolean => settings.dismissWhenOver !== false;

/** Whether two settings do the same, whether "on" is stored or left out. */
export const sameEventNotificationSettings = (
  a: EventNotificationSettings,
  b: EventNotificationSettings,
): boolean =>
  a.enabled === b.enabled &&
  a.includeAppleCalendar === b.includeAppleCalendar &&
  dismissesWhenOver(a) === dismissesWhenOver(b);

/**
 * `incoming` over `current`, in one key order so equal settings compare
 * equal: a field `incoming` leaves out (a Mac, an older file or client)
 * keeps the current value, so a save or an import never switches it back
 * on unasked.
 */
export const mergeEventNotificationSettings = (
  current: EventNotificationSettings,
  incoming: EventNotificationSettings,
): EventNotificationSettings => {
  const dismissWhenOver = incoming.dismissWhenOver ?? current.dismissWhenOver;
  return {
    ...(dismissWhenOver === undefined ? {} : { dismissWhenOver }),
    enabled: incoming.enabled,
    includeAppleCalendar: incoming.includeAppleCalendar,
  };
};

/**
 * Device-local task notification preferences: Google tasks and Apple
 * Reminders, both on by default. Stored next to the event ones.
 */
export const TaskNotificationSettings = Schema.Struct({
  /**
   * iOS: an Apple Reminder's delivered notification leaves Notification
   * Center once the reminder is checked off or gone. Absent reads as on
   * (`dismissesWhenDone`) and stays absent until someone flips the
   * switch, as `dismissWhenOver` does.
   */
  dismissRemindersWhenDone: Schema.optional(Schema.Boolean),
  /** The same for Google tasks. */
  dismissTasksWhenDone: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  /**
   * The Reminders app already notifies for a reminder that has an alert;
   * on means Solunivo notifies for every Apple Reminder too.
   */
  includeAppleReminders: Schema.Boolean,
  /** 'HH:MM' on the device's clock: when a task without a time of its own notifies on its due day. */
  time: Schema.String,
});
export type TaskNotificationSettings = typeof TaskNotificationSettings.Type;

export const DEFAULT_TASK_NOTIFICATION_TIME = '09:00';

export const DEFAULT_TASK_NOTIFICATION_SETTINGS: TaskNotificationSettings = {
  enabled: true,
  includeAppleReminders: true,
  time: DEFAULT_TASK_NOTIFICATION_TIME,
};

/** Whether a delivered notification leaves once its task is done, per provider: on unless switched off. */
export const dismissesWhenDone = (
  settings: Pick<TaskNotificationSettings, 'dismissRemindersWhenDone' | 'dismissTasksWhenDone'>,
  provider: TaskProvider,
): boolean =>
  (provider === 'apple' ? settings.dismissRemindersWhenDone : settings.dismissTasksWhenDone) !==
  false;

/** Whether two task settings do the same, whether an "on" is stored or left out. */
export const sameTaskNotificationSettings = (
  a: TaskNotificationSettings,
  b: TaskNotificationSettings,
): boolean =>
  a.enabled === b.enabled &&
  a.includeAppleReminders === b.includeAppleReminders &&
  a.time === b.time &&
  dismissesWhenDone(a, 'apple') === dismissesWhenDone(b, 'apple') &&
  dismissesWhenDone(a, 'google') === dismissesWhenDone(b, 'google');

/** `incoming` over `current`, as `mergeEventNotificationSettings`: a switch left out keeps its value. */
export const mergeTaskNotificationSettings = (
  current: TaskNotificationSettings,
  incoming: TaskNotificationSettings,
): TaskNotificationSettings => {
  const dismissRemindersWhenDone =
    incoming.dismissRemindersWhenDone ?? current.dismissRemindersWhenDone;
  const dismissTasksWhenDone = incoming.dismissTasksWhenDone ?? current.dismissTasksWhenDone;
  return {
    ...(dismissRemindersWhenDone === undefined ? {} : { dismissRemindersWhenDone }),
    ...(dismissTasksWhenDone === undefined ? {} : { dismissTasksWhenDone }),
    enabled: incoming.enabled,
    includeAppleReminders: incoming.includeAppleReminders,
    time: incoming.time,
  };
};

/** Copy shown under every device-local setting on both platforms. */
export const DEVICE_ONLY_SETTING_COPY =
  'Stored only on this device — not synced to your other devices or to Google.';
