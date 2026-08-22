import { plainDateToUtcMs } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';

/** The date/time inputs an event editor collects, as raw form strings. */
export interface EditorTimeFields {
  /** ISO date, `YYYY-MM-DD`. */
  readonly date: string;
  /** `HH:MM`, ignored for all-day events. */
  readonly endTime: string;
  readonly isAllDay: boolean;
  /** `HH:MM`, ignored for all-day events. */
  readonly startTime: string;
}

/** The time half of an event draft or update. */
export interface DraftEventTimes {
  readonly endDate?: string;
  readonly endUtc: number;
  readonly startDate?: string;
  readonly startTimeZone?: string;
  readonly startUtc: number;
}

const combine = (date: string, time: string, timeZone: string): number =>
  Temporal.PlainDate.from(date)
    .toZonedDateTime({ plainTime: Temporal.PlainTime.from(time), timeZone })
    .toInstant().epochMilliseconds;

/**
 * Turns editor form strings into event times. All-day events span whole
 * local dates (end exclusive, per Google); timed events carry the zone so
 * the wall clock survives DST shifts.
 */
export const buildEventTimes = (fields: EditorTimeFields, timeZone: string): DraftEventTimes => {
  if (fields.isAllDay) {
    const nextDay = Temporal.PlainDate.from(fields.date).add({ days: 1 }).toString();
    return {
      endDate: nextDay,
      endUtc: plainDateToUtcMs(nextDay),
      startDate: fields.date,
      startUtc: plainDateToUtcMs(fields.date),
    };
  }
  return {
    endUtc: combine(fields.date, fields.endTime, timeZone),
    startTimeZone: timeZone,
    startUtc: combine(fields.date, fields.startTime, timeZone),
  };
};

/** The editor's validation message, or null when the input is usable. */
export const validateEventDraft = (
  fields: { readonly calendarKey: string; readonly title: string } & EditorTimeFields,
  timeZone: string,
): string | null => {
  const [accountId, calendarId] = fields.calendarKey.split(':', 2);
  if (!accountId || !calendarId || !fields.title.trim()) {
    return 'A title and calendar are required.';
  }
  if (!fields.date) {
    return 'A date is required.';
  }
  let times: DraftEventTimes;
  try {
    times = buildEventTimes(fields, timeZone);
  } catch {
    return 'That date or time is not valid.';
  }
  if (!fields.isAllDay && times.endUtc <= times.startUtc) {
    return 'End must be after start.';
  }
  return null;
};
