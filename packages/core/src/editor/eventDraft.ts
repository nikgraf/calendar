import { plainDateToUtcMs, toZonedDateTime } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';

/** The date/time inputs an event editor collects, as raw form strings. */
export interface EditorTimeFields {
  /** ISO date, `YYYY-MM-DD`: the day the event starts. */
  readonly date: string;
  /**
   * ISO date the event ends on: an all-day event's last day (inclusive),
   * the end time's day for a timed one. Absent, it ends on `date`.
   */
  readonly endDate?: string | undefined;
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
 * local dates (end exclusive, per Google, so the day after the last);
 * timed events carry the zone so the wall clock survives DST shifts, and
 * end on their own date — an overnight event ends the next day.
 */
export const buildEventTimes = (fields: EditorTimeFields, timeZone: string): DraftEventTimes => {
  const endDate = fields.endDate ?? fields.date;
  if (fields.isAllDay) {
    const dayAfter = Temporal.PlainDate.from(endDate).add({ days: 1 }).toString();
    return {
      endDate: dayAfter,
      endUtc: plainDateToUtcMs(dayAfter),
      startDate: fields.date,
      startUtc: plainDateToUtcMs(fields.date),
    };
  }
  return {
    endUtc: combine(endDate, fields.endTime, timeZone),
    startTimeZone: timeZone,
    startUtc: combine(fields.date, fields.startTime, timeZone),
  };
};

/**
 * The editor's date fields for stored times, in `timeZone`: the start day
 * and the end day — an all-day event's last (inclusive), a timed one's
 * end time's. With the wall-clock times this is the inverse of
 * `buildEventTimes`, so a multi-day or overnight event keeps its span.
 */
export const editorDatesOf = (
  event: {
    readonly endDate?: string | undefined;
    readonly endUtc: number;
    readonly isAllDay: boolean;
    readonly startDate?: string | undefined;
    readonly startUtc: number;
  },
  timeZone: string,
): { readonly date: string; readonly endDate: string } => {
  const dayOf = (epochMs: number) => toZonedDateTime(epochMs, timeZone).toPlainDate().toString();
  const date = (event.isAllDay ? event.startDate : undefined) ?? dayOf(event.startUtc);
  if (!event.isAllDay) {
    return { date, endDate: dayOf(event.endUtc) };
  }
  // The exclusive end's day before is the last day; never before the first.
  const last = Temporal.PlainDate.from(event.endDate ?? dayOf(event.endUtc))
    .subtract({ days: 1 })
    .toString();
  return { date, endDate: last < date ? date : last };
};

/**
 * Whether the form's times differ from the ones it opened with. An update
 * whose times did not change leaves them out, so a title-only edit keeps
 * the stored span exactly — to the second, in the event's own zone — and
 * never rebuilds it from the form's minutes. Hidden times (all-day) do
 * not count.
 */
export const timeFieldsChanged = (fields: EditorTimeFields, opened: EditorTimeFields): boolean =>
  fields.date !== opened.date ||
  (fields.endDate ?? fields.date) !== (opened.endDate ?? opened.date) ||
  fields.isAllDay !== opened.isAllDay ||
  (!fields.isAllDay &&
    (fields.startTime !== opened.startTime || fields.endTime !== opened.endTime));

/** The editor's validation message, or null when the input is usable. */
export const validateEventDraft = (
  fields: { readonly calendarKey: string; readonly title: string } & EditorTimeFields,
  timeZone: string,
): string | null => {
  const [accountId, calendarId] = fields.calendarKey.split(':', 2);
  if (!accountId || !calendarId || !fields.title.trim()) {
    return 'A title and calendar are required.';
  }
  if (!fields.date || fields.endDate === '') {
    return 'A date is required.';
  }
  let times: DraftEventTimes;
  try {
    times = buildEventTimes(fields, timeZone);
  } catch {
    return 'That date or time is not valid.';
  }
  // An all-day end is the day after the last: equal means the last day
  // is before the first.
  if (times.endUtc <= times.startUtc) {
    return fields.isAllDay ? 'End must not be before start.' : 'End must be after start.';
  }
  return null;
};
