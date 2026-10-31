import { Schema } from 'effect';
import { formatPlainTime } from '../format.ts';
import type { PlannedNotification } from '../notifications/planned.ts';
import { parseTimeOfDay } from '../notifications/timeOfDay.ts';
import { Temporal } from '../time/temporal.ts';
import type { BirthdayRecord } from '../types.ts';
import { birthdayMergeKey, birthdaysInRange } from './model.ts';

/** The lead times a user can pick, in days before the birthday. */
export const BIRTHDAY_LEAD_DAYS = [0, 1, 3, 7, 14] as const;
export const BirthdayLeadDays = Schema.Literals([0, 1, 3, 7, 14]);
export type BirthdayLeadDays = typeof BirthdayLeadDays.Type;

/** One birthday notification: how many days ahead, at what time of day. */
export const BirthdayReminder = Schema.Struct({
  leadDays: BirthdayLeadDays,
  /** Delivery time of day, 'HH:MM' local. */
  time: Schema.String,
});
export type BirthdayReminder = typeof BirthdayReminder.Type;

/**
 * Device-local birthday reminder preferences. The first setting that
 * never syncs between macOS and iOS: it lives in the device_settings
 * table, and the UI says so. One reminder per lead time, each at its
 * own time of day ("3 days before at 18:00, on the day at 08:00").
 */
export const BirthdayReminderSettings = Schema.Struct({
  enabled: Schema.Boolean,
  reminders: Schema.Array(BirthdayReminder),
});
export type BirthdayReminderSettings = typeof BirthdayReminderSettings.Type;

/** Where a reminder lands when nothing else suggests a time. */
export const DEFAULT_BIRTHDAY_REMINDER_TIME = '09:00';

export const DEFAULT_BIRTHDAY_REMINDER_SETTINGS: BirthdayReminderSettings = {
  enabled: false,
  reminders: [{ leadDays: 0, time: DEFAULT_BIRTHDAY_REMINDER_TIME }],
};

/**
 * One person's own reminders, replacing the general ones: "Mom: 2 weeks
 * before as well", or none at all (an empty list mutes the person). The
 * person is named the way the merge names them — folded name plus month
 * and day (`birthdayMergeKey`) — so an override survives a source coming
 * or going and means the same person on the Mac and the iPhone. A rename
 * in the address book drops it.
 */
export const BirthdayReminderOverride = Schema.Struct({
  day: Schema.Number,
  displayName: Schema.String,
  month: Schema.Number,
  reminders: Schema.Array(BirthdayReminder),
});
export type BirthdayReminderOverride = typeof BirthdayReminderOverride.Type;

export const BirthdayReminderOverrides = Schema.Array(BirthdayReminderOverride);
export type BirthdayReminderOverrides = typeof BirthdayReminderOverrides.Type;

type BirthdayPerson = Pick<BirthdayRecord, 'day' | 'displayName' | 'month'>;

/** The list as stored: one reminder per lead time (the last one given wins), soonest lead first. */
export const canonicalBirthdayReminders = (
  reminders: ReadonlyArray<BirthdayReminder>,
): ReadonlyArray<BirthdayReminder> =>
  [...new Map(reminders.map((reminder) => [reminder.leadDays, reminder] as const)).values()]
    .map(({ leadDays, time }) => ({ leadDays, time }))
    .sort((a, b) => a.leadDays - b.leadDays);

/**
 * The time a newly added lead starts at: that of the reminder whose lead
 * is nearest (the shorter one on a tie), so someone who moved everything
 * to the evening is not pulled back to the morning; 09:00 for the first.
 */
export const newBirthdayReminderTime = (
  reminders: ReadonlyArray<BirthdayReminder>,
  leadDays: BirthdayLeadDays,
): string => {
  let nearest: BirthdayReminder | undefined;
  for (const reminder of canonicalBirthdayReminders(reminders)) {
    if (
      nearest === undefined ||
      Math.abs(reminder.leadDays - leadDays) < Math.abs(nearest.leadDays - leadDays)
    ) {
      nearest = reminder;
    }
  }
  return nearest?.time ?? DEFAULT_BIRTHDAY_REMINDER_TIME;
};

/** The list with a reminder at `leadDays` added (at `newBirthdayReminderTime`); already there, unchanged. */
export const addBirthdayReminder = (
  reminders: ReadonlyArray<BirthdayReminder>,
  leadDays: BirthdayLeadDays,
): ReadonlyArray<BirthdayReminder> =>
  reminders.some((reminder) => reminder.leadDays === leadDays)
    ? canonicalBirthdayReminders(reminders)
    : canonicalBirthdayReminders([
        ...reminders,
        { leadDays, time: newBirthdayReminderTime(reminders, leadDays) },
      ]);

/** The list without the reminder at `leadDays`. */
export const removeBirthdayReminder = (
  reminders: ReadonlyArray<BirthdayReminder>,
  leadDays: BirthdayLeadDays,
): ReadonlyArray<BirthdayReminder> =>
  canonicalBirthdayReminders(reminders.filter((reminder) => reminder.leadDays !== leadDays));

/** The list with the reminder at `leadDays` moved to `time` (added if missing). */
export const setBirthdayReminderTime = (
  reminders: ReadonlyArray<BirthdayReminder>,
  leadDays: BirthdayLeadDays,
  time: string,
): ReadonlyArray<BirthdayReminder> =>
  canonicalBirthdayReminders([...reminders, { leadDays, time }]);

/** The override stored for this person, if any. */
export const findBirthdayOverride = (
  overrides: BirthdayReminderOverrides,
  person: BirthdayPerson,
): BirthdayReminderOverride | undefined => {
  const key = birthdayMergeKey(person);
  return overrides.find((override) => birthdayMergeKey(override) === key);
};

/** The overrides as stored: one per person, reminders canonical, people in key order. */
export const canonicalBirthdayOverrides = (
  overrides: BirthdayReminderOverrides,
): BirthdayReminderOverrides => {
  const byKey = new Map<string, BirthdayReminderOverride>();
  for (const override of overrides) {
    byKey.set(birthdayMergeKey(override), {
      day: override.day,
      displayName: override.displayName,
      month: override.month,
      reminders: canonicalBirthdayReminders(override.reminders),
    });
  }
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
};

/** The overrides with this person's reminders replaced; `null` returns them to the general ones. */
export const withBirthdayOverride = (
  overrides: BirthdayReminderOverrides,
  person: BirthdayPerson,
  reminders: ReadonlyArray<BirthdayReminder> | null,
): BirthdayReminderOverrides => {
  const key = birthdayMergeKey(person);
  const others = overrides.filter((override) => birthdayMergeKey(override) !== key);
  return canonicalBirthdayOverrides(
    reminders === null
      ? others
      : [
          ...others,
          { day: person.day, displayName: person.displayName, month: person.month, reminders },
        ],
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value in the shape before each reminder had its own time: `{ leadDays: [0, 7], … }`. */
const isLegacy = (
  value: unknown,
): value is Record<string, unknown> & { leadDays: Array<unknown> } =>
  isRecord(value) && Array.isArray(value['leadDays']) && !('reminders' in value);

/**
 * Birthday settings as stored or exported before each reminder had its
 * own time — general `{ enabled, leadDays, time }`, per person
 * `{ …, leadDays }` — in today's shape: every lead at the one time the
 * general settings had (a person's too, since they shared it). Values in
 * today's shape, and anything unrecognised, pass through for the schema
 * to judge; `undefined` stays `undefined`.
 */
export const upgradeBirthdayReminderData = (stored: {
  readonly overrides: unknown;
  readonly settings: unknown;
}): { readonly overrides: unknown; readonly settings: unknown } => {
  const { settings } = stored;
  const firstTime =
    isRecord(settings) && Array.isArray(settings['reminders'])
      ? (settings['reminders'] as ReadonlyArray<unknown>).find(isRecord)?.['time']
      : undefined;
  const sharedTime = isLegacy(settings) ? settings['time'] : firstTime;
  const time = typeof sharedTime === 'string' ? sharedTime : DEFAULT_BIRTHDAY_REMINDER_TIME;
  const remindersOf = (leadDays: ReadonlyArray<unknown>) =>
    leadDays.map((lead) => ({ leadDays: lead, time }));
  return {
    overrides: Array.isArray(stored.overrides)
      ? stored.overrides.map((override: unknown) =>
          isLegacy(override)
            ? {
                day: override['day'],
                displayName: override['displayName'],
                month: override['month'],
                reminders: remindersOf(override.leadDays),
              }
            : override,
        )
      : stored.overrides,
    settings: isLegacy(settings)
      ? { enabled: settings['enabled'], reminders: remindersOf(settings.leadDays) }
      : settings,
  };
};

/** "On the day at 9:00 AM, 1 week before at 6:00 PM" / "No reminder" — a person's list in Settings. */
export const birthdayRemindersSummary = (reminders: ReadonlyArray<BirthdayReminder>): string =>
  reminders.length === 0
    ? 'No reminder'
    : canonicalBirthdayReminders(reminders)
        .map((reminder, index) => {
          const lead = leadDaysLabel(reminder.leadDays);
          return `${index === 0 ? lead : lead.toLowerCase()} at ${birthdayReminderTimeLabel(reminder.time)}`;
        })
        .join(', ');

/** "9:00 AM" for a stored 'HH:MM' (a malformed one reads as the 09:00 it fires at). */
export const birthdayReminderTimeLabel = (time: string): string => {
  const { hour, minute } = parseTimeOfDay(time);
  return formatPlainTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
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

/** A missed birthday reminder is still worth showing for the rest of the day. */
const BIRTHDAY_CATCH_UP_MS = 24 * 60 * 60 * 1000;

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
 * horizonDays]`, one per reminder, each at its own time of day in
 * `timeZone`. A person with an override gets their own reminders instead
 * of the general ones; the general switch still gates everything.
 * Occurrences are read two weeks past the horizon so a
 * January birthday's two-week lead still fires in December. Fire dates
 * before `fromDate` are dropped; sinks decide what "already fired" means.
 */
export const planBirthdayReminders = (
  records: ReadonlyArray<BirthdayRecord>,
  settings: BirthdayReminderSettings,
  options: {
    readonly fromDate: string;
    readonly horizonDays: number;
    /** When birthday reminders were last configured on this device (the settings row's stamp). */
    readonly since?: number | undefined;
    readonly timeZone: string;
  },
  overrides: BirthdayReminderOverrides = [],
): ReadonlyArray<PlannedNotification> => {
  if (!settings.enabled) {
    return [];
  }
  const general = canonicalBirthdayReminders(settings.reminders);
  const overrideByKey = new Map(
    overrides.map(
      (override) =>
        [birthdayMergeKey(override), canonicalBirthdayReminders(override.reminders)] as const,
    ),
  );
  const allLeads = [...general, ...[...overrideByKey.values()].flat()].map(
    (reminder) => reminder.leadDays,
  );
  if (allLeads.length === 0) {
    return [];
  }
  const from = Temporal.PlainDate.from(options.fromDate);
  const maxLead = Math.max(...allLeads);
  const until = from.add({ days: options.horizonDays + maxLead });
  const out: Array<PlannedNotification> = [];
  for (const occurrence of birthdaysInRange(records, options.fromDate, until.toString())) {
    const date = Temporal.PlainDate.from(occurrence.date);
    const reminders = overrideByKey.get(birthdayMergeKey(occurrence.record)) ?? general;
    for (const { leadDays, time } of reminders) {
      const fireDate = date.subtract({ days: leadDays });
      if (Temporal.PlainDate.compare(fireDate, from) < 0) {
        continue;
      }
      const turns = occurrence.age === undefined ? '' : ` — turns ${String(occurrence.age)}`;
      const when =
        leadDays === 0
          ? ''
          : ` (${date.toLocaleString('en-US', { day: 'numeric', month: 'short', weekday: 'short' })})`;
      const { hour, minute } = parseTimeOfDay(time);
      const fireAt = fireDate.toZonedDateTime({
        plainTime: new Temporal.PlainTime(hour, minute),
        timeZone: options.timeZone,
      }).epochMilliseconds;
      out.push({
        body: `Birthday ${leadPhrase(leadDays)}${turns}${when}`,
        expiresAt: fireAt + BIRTHDAY_CATCH_UP_MS,
        fireAt,
        // Prefixed so the merged notification schedule keeps producers apart.
        // One reminder per lead, so the lead names it; a new time keeps the key.
        key: `birthday:${occurrence.record.id}:${occurrence.date}:${String(leadDays)}`,
        since: options.since,
        title: `🎂 ${occurrence.record.displayName}`,
      });
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key));
};
