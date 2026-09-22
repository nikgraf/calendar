import { Schema } from 'effect';

/**
 * Device-local event notification preferences, stored next to the
 * birthday ones in the device_settings table and never synced.
 */
export const EventNotificationSettings = Schema.Struct({
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

/** Copy shown under every device-local setting on both platforms. */
export const DEVICE_ONLY_SETTING_COPY =
  'Stored only on this device — not synced to your other devices or to Google.';
