import { Schema } from 'effect';

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

/** Copy shown under every device-local setting on both platforms. */
export const DEVICE_ONLY_SETTING_COPY =
  'Stored only on this device — not synced to your other devices or to Google.';
