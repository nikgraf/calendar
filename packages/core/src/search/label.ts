import { formatClockTime, formatPlainTime } from '../format.ts';
import { addDaysToPlainDate, toZonedDateTime } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';
import { formatZoneTimeRange } from '../time/zoneLabels.ts';
import type { EventRecord, TaskRecord } from '../types.ts';

/** "Tue, Oct 14", with the year once it is not `today`'s. */
const dayLabel = (date: Temporal.PlainDate, today: string): string =>
  date.toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
    ...(date.year === Temporal.PlainDate.from(today).year ? {} : { year: 'numeric' }),
  });

/**
 * When a search hit takes place, in `timeZone`: "Tue, Oct 14 · 9:00 –
 * 10:00 AM", "Fri, Oct 17 · All day", "Fri, Oct 17 – Sun, Oct 19 · All
 * day", or across midnight "Tue, Oct 14, 9:00 PM – Wed, Oct 15, 1:00 AM".
 * A date outside `today`'s year carries its year.
 */
export const searchEventWhen = (
  event: Pick<EventRecord, 'endDate' | 'endUtc' | 'isAllDay' | 'startDate' | 'startUtc'>,
  timeZone: string,
  today: string,
): string => {
  if (event.isAllDay && event.startDate !== undefined) {
    const first = Temporal.PlainDate.from(event.startDate);
    // The end date is exclusive: an event on one day ends on the next.
    const last = Temporal.PlainDate.from(
      addDaysToPlainDate(event.endDate ?? addDaysToPlainDate(event.startDate, 1), -1),
    );
    return Temporal.PlainDate.compare(last, first) > 0
      ? `${dayLabel(first, today)} – ${dayLabel(last, today)} · All day`
      : `${dayLabel(first, today)} · All day`;
  }
  const startDay = toZonedDateTime(event.startUtc, timeZone).toPlainDate();
  // An event ending at midnight still belongs to its start day: one date.
  const lastDay = toZonedDateTime(
    Math.max(event.startUtc, event.endUtc - 1),
    timeZone,
  ).toPlainDate();
  if (startDay.equals(lastDay)) {
    const times = formatZoneTimeRange(event.startUtc, event.endUtc, timeZone);
    return `${dayLabel(startDay, today)} · ${times}`;
  }
  // Longer, its end is named by the day it falls on (midnight: the next one).
  const endDay = toZonedDateTime(event.endUtc, timeZone).toPlainDate();
  const start = `${dayLabel(startDay, today)}, ${formatClockTime(event.startUtc, timeZone)}`;
  const end = `${dayLabel(endDay, today)}, ${formatClockTime(event.endUtc, timeZone)}`;
  return `${start} – ${end}`;
};

/** A task result's date line: "Due Tue, Oct 14", "Due Tue, Oct 14, 9:00 AM" or "No due date". */
export const searchTaskWhen = (
  task: Pick<TaskRecord, 'dueDate' | 'dueTime'>,
  today: string,
): string =>
  task.dueDate === undefined
    ? 'No due date'
    : `Due ${dayLabel(Temporal.PlainDate.from(task.dueDate), today)}${
        task.dueTime === undefined ? '' : `, ${formatPlainTime(task.dueTime)}`
      }`;
