import { Schema } from 'effect';

/** The lead times a user can pick, in days before the birthday. */
export const BIRTHDAY_LEAD_DAYS = [0, 1, 3, 7, 14] as const;
export const BirthdayLeadDays = Schema.Literals([0, 1, 3, 7, 14]);
export type BirthdayLeadDays = typeof BirthdayLeadDays.Type;

/**
 * Device-local birthday reminder preferences. The first setting that
 * never syncs between macOS and iOS: it lives in the device_settings
 * table, and the UI says so.
 */
export const BirthdayReminderSettings = Schema.Struct({
  enabled: Schema.Boolean,
  leadDays: Schema.Array(BirthdayLeadDays),
  /** Delivery time of day, 'HH:MM' local. */
  time: Schema.String,
});
export type BirthdayReminderSettings = typeof BirthdayReminderSettings.Type;

export const DEFAULT_BIRTHDAY_REMINDER_SETTINGS: BirthdayReminderSettings = {
  enabled: false,
  leadDays: [0],
  time: '09:00',
};

/** "On the day" / "1 day before" / "1 week before" — the same words on both platforms. */
export const leadDaysLabel = (leadDays: BirthdayLeadDays): string => {
  switch (leadDays) {
    case 0:
      return 'On the day';
    case 1:
      return '1 day before';
    case 3:
      return '3 days before';
    case 7:
      return '1 week before';
    case 14:
      return '2 weeks before';
  }
};

/** Copy shown under the settings on both platforms. */
export const BIRTHDAY_REMINDERS_DEVICE_ONLY =
  'Stored only on this device — not synced to your other devices or to Google.';
