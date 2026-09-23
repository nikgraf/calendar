import { formatClockTime } from '../format.ts';
import { Temporal } from '../time/temporal.ts';
import {
  type CalendarInfo,
  type EventRecord,
  EventReminders,
  isAppleCalendarAccount,
  ReminderOverride,
} from '../types.ts';
import type { PlannedNotification } from './planned.ts';

/** Google's ceiling: four weeks. */
export const MAX_REMINDER_MINUTES = 40_320;
/** Google refuses more than five overrides per event. */
export const MAX_REMINDER_OVERRIDES = 5;

/** The offsets the editors offer for a timed event. */
export const REMINDER_PRESET_MINUTES = [0, 5, 10, 15, 30, 60, 120, 1440] as const;
/**
 * The offsets the editors offer for an all-day event: minutes before local
 * midnight of the day. 420 = the day before at 17:00, 900 = at 09:00.
 */
export const ALL_DAY_REMINDER_PRESET_MINUTES = [0, 420, 900, 1440, 10_080] as const;

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

const plural = (count: number, unit: string): string =>
  `${String(count)} ${unit}${count === 1 ? '' : 's'}`;

const clockOfDay = (minutesAfterMidnight: number): string =>
  Temporal.PlainTime.from({
    hour: Math.floor(minutesAfterMidnight / 60),
    minute: minutesAfterMidnight % 60,
  }).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "10 minutes before" / "1 day before" / all-day: "The day before at 9:00 AM". */
export const reminderLabel = (minutes: number, isAllDay: boolean): string => {
  if (isAllDay) {
    const days = Math.floor(minutes / DAY_MINUTES);
    const remainder = minutes % DAY_MINUTES;
    if (remainder === 0) {
      return days === 0 ? 'At midnight' : plural(days, 'day') + ' before';
    }
    const when = clockOfDay(DAY_MINUTES - remainder);
    return days === 0
      ? `The day before at ${when}`
      : `${plural(days + 1, 'day')} before at ${when}`;
  }
  if (minutes === 0) {
    return 'At time of event';
  }
  if (minutes % (7 * DAY_MINUTES) === 0) {
    return plural(minutes / (7 * DAY_MINUTES), 'week') + ' before';
  }
  if (minutes % DAY_MINUTES === 0) {
    return plural(minutes / DAY_MINUTES, 'day') + ' before';
  }
  if (minutes % 60 === 0) {
    return plural(minutes / 60, 'hour') + ' before';
  }
  return plural(minutes, 'minute') + ' before';
};

/**
 * The stored form: valid whole minutes only, deduped, sorted by method then
 * offset, at most five. Every write (editor, mapping, move) passes through
 * here so equal reminder sets compare equal.
 */
export const canonicalReminders = (reminders: EventReminders): EventReminders => {
  const seen = new Set<string>();
  const overrides: Array<ReminderOverride> = [];
  for (const override of reminders.overrides) {
    // `+ 0` folds the -0 an EventKit offset of 0 arrives as.
    const minutes = Math.round(override.minutes) + 0;
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_REMINDER_MINUTES) {
      continue;
    }
    const id = `${override.method}:${String(minutes)}`;
    if (!seen.has(id)) {
      seen.add(id);
      overrides.push(new ReminderOverride({ method: override.method, minutes }));
    }
  }
  overrides.sort((a, b) => a.method.localeCompare(b.method) || a.minutes - b.minutes);
  return new EventReminders({
    overrides: overrides.slice(0, MAX_REMINDER_OVERRIDES),
    useDefault: reminders.useDefault,
  });
};

const popupMinutes = (overrides: ReadonlyArray<ReminderOverride> | undefined): Array<number> =>
  [...new Set((overrides ?? []).filter((o) => o.method === 'popup').map((o) => o.minutes))].sort(
    (a, b) => a - b,
  );

/**
 * The offsets that notify locally: the event's popup overrides, or the
 * calendar's defaults when the event defers to them. A Google row synced
 * before reminders were modelled (field absent) defers too; an Apple event
 * without alarms has none.
 */
export const effectivePopupMinutes = (
  event: Pick<EventRecord, 'accountId' | 'reminders'>,
  calendar: Pick<CalendarInfo, 'defaultReminders'> | undefined,
): ReadonlyArray<number> => {
  if (event.reminders === undefined) {
    return isAppleCalendarAccount({ id: event.accountId })
      ? []
      : popupMinutes(calendar?.defaultReminders);
  }
  return event.reminders.useDefault
    ? popupMinutes(calendar?.defaultReminders)
    : popupMinutes(event.reminders.overrides);
};

const selfDeclined = (event: EventRecord): boolean =>
  event.attendees?.some(
    (attendee) => attendee.isSelf === true && attendee.responseStatus === 'declined',
  ) === true;

/** "In 10 minutes · 3:00 PM · Room 4B", "Starting now · …", "All day tomorrow · …". */
const eventReminderBody = (
  event: EventRecord,
  minutes: number,
  fireAt: number,
  timeZone: string,
): string => {
  const parts: Array<string> = [];
  if (event.isAllDay) {
    const days = Math.ceil(minutes / DAY_MINUTES);
    parts.push(
      days === 0
        ? 'All day today'
        : days === 1
          ? 'All day tomorrow'
          : `All day ${Temporal.PlainDate.from(event.startDate ?? '1970-01-01').toLocaleString('en-US', { day: 'numeric', month: 'short', weekday: 'short' })}`,
    );
  } else {
    const lead =
      minutes === 0
        ? 'Starting now'
        : minutes % DAY_MINUTES === 0
          ? `In ${plural(minutes / DAY_MINUTES, 'day')}`
          : minutes % 60 === 0
            ? `In ${plural(minutes / 60, 'hour')}`
            : `In ${plural(minutes, 'minute')}`;
    const startDay = Temporal.Instant.fromEpochMilliseconds(event.startUtc)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate();
    const fireDay = Temporal.Instant.fromEpochMilliseconds(fireAt)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate();
    const daysAhead = fireDay.until(startDay, { largestUnit: 'day' }).days;
    const dayPrefix =
      daysAhead <= 0
        ? ''
        : daysAhead === 1
          ? 'Tomorrow '
          : `${startDay.toLocaleString('en-US', { day: 'numeric', month: 'short', weekday: 'short' })} `;
    parts.push(lead, `${dayPrefix}${formatClockTime(event.startUtc, timeZone)}`);
  }
  if (event.location) {
    parts.push(event.location);
  }
  return parts.join(' · ');
};

/** A timed reminder stops being worth showing five minutes into the event. */
const TIMED_GRACE_MS = 5 * MINUTE;
/** An all-day one stays useful through the morning. */
const ALL_DAY_GRACE_MS = 12 * 60 * MINUTE;

/**
 * Every notification due for the (already expanded) events whose delivery
 * falls in `[from, until)`. Cancelled events, ones the user declined and —
 * unless `includeApple` — Apple Calendar events (Calendar.app fires those
 * itself) are skipped. All-day offsets count from local midnight of the
 * start day in the calendar's zone (Google) or the device's (Apple).
 */
export const planEventReminders = (
  events: ReadonlyArray<EventRecord>,
  options: {
    readonly calendars: ReadonlyArray<CalendarInfo>;
    readonly deviceTimeZone: string;
    readonly from: number;
    readonly includeApple: boolean;
    readonly until: number;
  },
): ReadonlyArray<PlannedNotification> => {
  const calendars = new Map(
    options.calendars.map((calendar) => [`${calendar.accountId}:${calendar.id}`, calendar]),
  );
  const out: Array<PlannedNotification> = [];
  for (const event of events) {
    const isApple = isAppleCalendarAccount({ id: event.accountId });
    if (event.status === 'cancelled' || selfDeclined(event) || (isApple && !options.includeApple)) {
      continue;
    }
    const calendar = calendars.get(`${event.accountId}:${event.calendarId}`);
    const timeZone = isApple
      ? options.deviceTimeZone
      : (event.startTimeZone ?? calendar?.timeZone ?? options.deviceTimeZone);
    // Never startUtc for an all-day event: that is UTC midnight, not local.
    const startRef =
      event.isAllDay && event.startDate
        ? Temporal.PlainDate.from(event.startDate).toZonedDateTime({ timeZone }).epochMilliseconds
        : event.startUtc;
    for (const minutes of effectivePopupMinutes(event, calendar)) {
      const fireAt = startRef - minutes * MINUTE;
      if (fireAt < options.from || fireAt >= options.until) {
        continue;
      }
      out.push({
        body: eventReminderBody(event, minutes, fireAt, timeZone),
        expiresAt: startRef + (event.isAllDay ? ALL_DAY_GRACE_MS : TIMED_GRACE_MS),
        fireAt,
        key: `event:${event.accountId}/${event.calendarId}/${event.id}:${String(event.startUtc)}:${String(minutes)}`,
        title: event.title,
      });
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key));
};
