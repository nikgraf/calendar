import { Schema } from 'effect';
import type { PlannedNotification } from '../notifications/planned.ts';
import { Temporal } from '../time/temporal.ts';
import type { BirthdayRecord } from '../types.ts';
import { birthdayMergeKey, birthdaysInRange } from './model.ts';

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

/**
 * One person's own lead days, replacing the general ones: "Mom: 2 weeks
 * before as well", or none at all (an empty list mutes the person). The
 * person is named the way the merge names them — folded name plus month
 * and day (`birthdayMergeKey`) — so an override survives a source coming
 * or going and means the same person on the Mac and the iPhone. A rename
 * in the address book drops it.
 */
export const BirthdayReminderOverride = Schema.Struct({
  day: Schema.Number,
  displayName: Schema.String,
  leadDays: Schema.Array(BirthdayLeadDays),
  month: Schema.Number,
});
export type BirthdayReminderOverride = typeof BirthdayReminderOverride.Type;

export const BirthdayReminderOverrides = Schema.Array(BirthdayReminderOverride);
export type BirthdayReminderOverrides = typeof BirthdayReminderOverrides.Type;

type BirthdayPerson = Pick<BirthdayRecord, 'day' | 'displayName' | 'month'>;

const canonicalLeadDays = (
  leadDays: ReadonlyArray<BirthdayLeadDays>,
): ReadonlyArray<BirthdayLeadDays> => [...new Set(leadDays)].sort((a, b) => a - b);

/** The override stored for this person, if any. */
export const findBirthdayOverride = (
  overrides: BirthdayReminderOverrides,
  person: BirthdayPerson,
): BirthdayReminderOverride | undefined => {
  const key = birthdayMergeKey(person);
  return overrides.find((override) => birthdayMergeKey(override) === key);
};

/** The overrides as stored: one per person, lead days deduped and sorted, people in key order. */
export const canonicalBirthdayOverrides = (
  overrides: BirthdayReminderOverrides,
): BirthdayReminderOverrides => {
  const byKey = new Map<string, BirthdayReminderOverride>();
  for (const override of overrides) {
    byKey.set(birthdayMergeKey(override), {
      day: override.day,
      displayName: override.displayName,
      leadDays: canonicalLeadDays(override.leadDays),
      month: override.month,
    });
  }
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
};

/** The overrides with this person's lead days replaced; `null` returns them to the general ones. */
export const withBirthdayOverride = (
  overrides: BirthdayReminderOverrides,
  person: BirthdayPerson,
  leadDays: ReadonlyArray<BirthdayLeadDays> | null,
): BirthdayReminderOverrides => {
  const key = birthdayMergeKey(person);
  const others = overrides.filter((override) => birthdayMergeKey(override) !== key);
  return canonicalBirthdayOverrides(
    leadDays === null
      ? others
      : [
          ...others,
          { day: person.day, displayName: person.displayName, leadDays, month: person.month },
        ],
  );
};

/** "On the day, 2 weeks before" / "No reminder" — how a person's own list reads in Settings. */
export const leadDaysSummary = (leadDays: ReadonlyArray<BirthdayLeadDays>): string =>
  leadDays.length === 0
    ? 'No reminder'
    : canonicalLeadDays(leadDays)
        .map((lead, index) =>
          index === 0 ? leadDaysLabel(lead) : leadDaysLabel(lead).toLowerCase(),
        )
        .join(', ');

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

/** A missed birthday reminder is still worth showing for the rest of the day. */
const BIRTHDAY_CATCH_UP_MS = 24 * 60 * 60 * 1000;

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
 * `timeZone`. A person with an override gets their own lead days instead
 * of the general ones; the general switch still gates everything.
 * Occurrences are read two weeks past the horizon so a
 * January birthday's two-week lead still fires in December. Fire dates
 * before `fromDate` are dropped; sinks decide what "already fired" means.
 */
export const planBirthdayReminders = (
  records: ReadonlyArray<BirthdayRecord>,
  settings: BirthdayReminderSettings,
  options: { readonly fromDate: string; readonly horizonDays: number; readonly timeZone: string },
  overrides: BirthdayReminderOverrides = [],
): ReadonlyArray<PlannedNotification> => {
  if (!settings.enabled) {
    return [];
  }
  const overrideByKey = new Map(
    overrides.map((override) => [birthdayMergeKey(override), override.leadDays] as const),
  );
  const allLeads = [...settings.leadDays, ...overrides.flatMap((override) => override.leadDays)];
  if (allLeads.length === 0) {
    return [];
  }
  const from = Temporal.PlainDate.from(options.fromDate);
  const maxLead = Math.max(...allLeads);
  const until = from.add({ days: options.horizonDays + maxLead });
  const { hour, minute } = parseTime(settings.time);
  const plainTime = new Temporal.PlainTime(hour, minute);
  const out: Array<PlannedNotification> = [];
  for (const occurrence of birthdaysInRange(records, options.fromDate, until.toString())) {
    const date = Temporal.PlainDate.from(occurrence.date);
    const leads = overrideByKey.get(birthdayMergeKey(occurrence.record)) ?? settings.leadDays;
    for (const leadDays of leads) {
      const fireDate = date.subtract({ days: leadDays });
      if (Temporal.PlainDate.compare(fireDate, from) < 0) {
        continue;
      }
      const turns = occurrence.age === undefined ? '' : ` — turns ${String(occurrence.age)}`;
      const when =
        leadDays === 0
          ? ''
          : ` (${date.toLocaleString('en-US', { day: 'numeric', month: 'short', weekday: 'short' })})`;
      const fireAt = fireDate.toZonedDateTime({
        plainTime,
        timeZone: options.timeZone,
      }).epochMilliseconds;
      out.push({
        body: `Birthday ${leadPhrase(leadDays)}${turns}${when}`,
        expiresAt: fireAt + BIRTHDAY_CATCH_UP_MS,
        fireAt,
        // Prefixed so the merged notification schedule keeps producers apart.
        key: `birthday:${occurrence.record.id}:${occurrence.date}:${String(leadDays)}`,
        title: `🎂 ${occurrence.record.displayName}`,
      });
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key));
};
