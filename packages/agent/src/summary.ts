import { addDaysToPlainDate, formatClockTime, Temporal, toZonedDateTime } from '@calendar/core';
import type { RequestSummary } from './store.ts';
import type { EventTimes, ExistingTimes } from './times.ts';

/**
 * The text the user approves and later reads in the activity list. It is
 * built here, from what the gateway resolved and will execute — never
 * from anything the agent says about its own request.
 */

const DAY: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  weekday: 'short',
  year: 'numeric',
};

const formatDay = (isoDate: string): string =>
  Temporal.PlainDate.from(isoDate).toLocaleString('en-US', DAY);

/** "Thu, Oct 1, 2026, 2:00 PM – 3:00 PM (Europe/Vienna)" / "Thu, Oct 1, 2026 (all day)". */
export const describeWhen = (times: EventTimes | ExistingTimes, timeZone: string): string => {
  if (times.isAllDay && times.startDate !== undefined && times.endDate !== undefined) {
    const last = addDaysToPlainDate(times.endDate, -1);
    return last === times.startDate
      ? `${formatDay(times.startDate)} (all day)`
      : `${formatDay(times.startDate)} – ${formatDay(last)} (all day)`;
  }
  const zone = ('startTimeZone' in times ? times.startTimeZone : undefined) ?? timeZone;
  const start = toZonedDateTime(times.startUtc, zone);
  const end = toZonedDateTime(times.endUtc, zone);
  const startDay = start.toPlainDate().toLocaleString('en-US', DAY);
  const sameDay = start.toPlainDate().equals(end.toPlainDate());
  const endText = sameDay
    ? formatClockTime(times.endUtc, zone)
    : `${end.toPlainDate().toLocaleString('en-US', DAY)}, ${formatClockTime(times.endUtc, zone)}`;
  return `${startDay}, ${formatClockTime(times.startUtc, zone)} – ${endText} (${zone})`;
};

const quote = (value: string): string => `“${value}”`;

const clip = (value: string, max = 160): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const SCOPE_LABEL = {
  following: 'This and all following occurrences',
  instance: 'Only this occurrence',
  series: 'Every occurrence of the series',
} as const;

export const scopeLine = (scope: keyof typeof SCOPE_LABEL): string =>
  `Applies to: ${SCOPE_LABEL[scope]}`;

export const guestsLine = (emails: ReadonlyArray<string>): string =>
  `Guests: ${emails.slice(0, 8).join(', ')}${emails.length > 8 ? ` and ${emails.length - 8} more` : ''}`;

export const calendarLine = (name: string, account: string): string =>
  `Calendar: ${name} (${account})`;

export const listLine = (name: string, account: string): string => `List: ${name} (${account})`;

/** "Title: “A” → “B”" — one changed text field. */
export const changeLine = (label: string, before: string | undefined, after: string): string =>
  before === undefined || before === ''
    ? `${label}: ${after === '' ? '(empty)' : quote(clip(after))}`
    : `${label}: ${quote(clip(before))} → ${after === '' ? '(cleared)' : quote(clip(after))}`;

export const textLine = (label: string, value: string): string => `${label}: ${clip(value)}`;

export const summarize = (
  title: string,
  lines: ReadonlyArray<string | false | undefined>,
): RequestSummary => ({
  lines: lines.filter((line): line is string => typeof line === 'string'),
  title,
});

export const titled = (verb: string, noun: string, title: string): string =>
  `${verb} ${noun} ${quote(clip(title, 80))}`;
