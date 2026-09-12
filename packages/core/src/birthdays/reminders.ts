import { Schema } from 'effect';
import { Temporal } from '../time/temporal.ts';
import type { BirthdayRecord } from '../types.ts';
import { birthdaysInRange } from './model.ts';

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

/** One local notification the platform sink delivers or schedules. */
export interface PlannedNotification {
  readonly body: string;
  /** Epoch ms of delivery in the planner's time zone. */
  readonly fireAt: number;
  /** `<recordId>:<occurrenceDate>:<leadDays>` — stable across runs, so a sink can dedupe. */
  readonly key: string;
  readonly title: string;
}

const parseTime = (time: string): { readonly hour: number; readonly minute: number } => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  const hour = match ? Number(match[1]) : Number.NaN;
  const minute = match ? Number(match[2]) : Number.NaN;
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60
    ? { hour, minute }
    : { hour: 9, minute: 0 };
};

const leadPhrase = (leadDays: number): string => {
  switch (leadDays) {
    case 0:
      return 'today';
    case 1:
      return 'tomorrow';
    case 7:
      return 'in a week';
    case 14:
      return 'in two weeks';
    default:
      return `in ${String(leadDays)} days`;
  }
};

/**
 * Every notification due for the birthdays in `[fromDate, fromDate +
 * horizonDays]`, per lead time, at the settings' time of day in
 * `timeZone`. Occurrences are read two weeks past the horizon so a
 * January birthday's two-week lead still fires in December. Fire dates
 * before `fromDate` are dropped; sinks decide what "already fired" means.
 */
export const planBirthdayReminders = (
  records: ReadonlyArray<BirthdayRecord>,
  settings: BirthdayReminderSettings,
  options: { readonly fromDate: string; readonly horizonDays: number; readonly timeZone: string },
): ReadonlyArray<PlannedNotification> => {
  if (!settings.enabled || settings.leadDays.length === 0) {
    return [];
  }
  const from = Temporal.PlainDate.from(options.fromDate);
  const maxLead = Math.max(...settings.leadDays);
  const until = from.add({ days: options.horizonDays + maxLead });
  const { hour, minute } = parseTime(settings.time);
  const plainTime = new Temporal.PlainTime(hour, minute);
  const out: Array<PlannedNotification> = [];
  for (const occurrence of birthdaysInRange(records, options.fromDate, until.toString())) {
    const date = Temporal.PlainDate.from(occurrence.date);
    for (const leadDays of settings.leadDays) {
      const fireDate = date.subtract({ days: leadDays });
      if (Temporal.PlainDate.compare(fireDate, from) < 0) {
        continue;
      }
      const turns = occurrence.age === undefined ? '' : ` — turns ${String(occurrence.age)}`;
      const when =
        leadDays === 0
          ? ''
          : ` (${date.toLocaleString('en-US', { day: 'numeric', month: 'short', weekday: 'short' })})`;
      out.push({
        body: `Birthday ${leadPhrase(leadDays)}${turns}${when}`,
        fireAt: fireDate.toZonedDateTime({ plainTime, timeZone: options.timeZone })
          .epochMilliseconds,
        key: `${occurrence.record.id}:${occurrence.date}:${String(leadDays)}`,
        title: `🎂 ${occurrence.record.displayName}`,
      });
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key));
};
