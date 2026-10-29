import { Schema } from 'effect';

/**
 * Device-local event notification preferences, stored next to the
 * birthday ones in the device_settings table and never synced.
 */
export const EventNotificationSettings = Schema.Struct({
  /**
   * iOS: a delivered reminder leaves Notification Center once its event
   * is over (`dismissAt`). Absent reads as on: rows, files and clients
   * from before it existed (`dismissesWhenOver`).
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
  dismissWhenOver: true,
  enabled: true,
  includeAppleCalendar: false,
};

/** Whether delivered reminders leave once their event is over: on unless switched off. */
export const dismissesWhenOver = (
  settings: Pick<EventNotificationSettings, 'dismissWhenOver'>,
): boolean => settings.dismissWhenOver !== false;

/**
 * `incoming` over `current`, every field filled in: a field `incoming`
 * leaves out (a file or client from before it existed) keeps the current
 * value, so a save or an import never switches it back on unasked.
 */
export const mergeEventNotificationSettings = (
  current: EventNotificationSettings,
  incoming: EventNotificationSettings,
): EventNotificationSettings => ({
  dismissWhenOver: incoming.dismissWhenOver ?? dismissesWhenOver(current),
  enabled: incoming.enabled,
  includeAppleCalendar: incoming.includeAppleCalendar,
});

/** Copy shown under every device-local setting on both platforms. */
export const DEVICE_ONLY_SETTING_COPY =
  'Stored only on this device — not synced to your other devices or to Google.';
