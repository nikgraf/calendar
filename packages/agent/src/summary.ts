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

/**
 * Text from an agent or an invitation, safe to show as one line of a
 * summary: a line break inside it must not be able to pose as another
 * line ("Guests: nobody"), so breaks are shown as a visible mark and
 * other control characters are dropped. Nothing is ever shortened here —
 * the user approves the whole of what is written, and input sizes are
 * capped where the request is planned.
 */
export const oneLine = (value: string): string =>
  value
    .replaceAll(/\s*(?:\r\n|[\n\r\u2028\u2029])\s*/gu, ' ⏎ ')
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replaceAll(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/gu, '');

const quote = (value: string): string => `“${oneLine(value)}”`;

const SCOPE_LABEL = {
  following: 'This and all following occurrences',
  instance: 'Only this occurrence',
  series: 'Every occurrence of the series',
} as const;

export const scopeLine = (scope: keyof typeof SCOPE_LABEL): string =>
  `Applies to: ${SCOPE_LABEL[scope]}`;

/** Every guest, always: this is who gets mail. */
export const guestsLine = (emails: ReadonlyArray<string>): string =>
  `Guests: ${emails.map(oneLine).join(', ')}`;

/** People a write reaches, by address — a count would let one guest be swapped for another unnoticed. */
export const peopleLine = (label: string, emails: ReadonlyArray<string>): string =>
  `${label}: ${emails.map(oneLine).join(', ')}`;

export const calendarLine = (name: string, account: string): string =>
  `Calendar: ${oneLine(name)} (${oneLine(account)})`;

export const listLine = (name: string, account: string): string =>
  `List: ${oneLine(name)} (${oneLine(account)})`;

/** "Title: “A” → “B”" — one changed text field. */
export const changeLine = (label: string, before: string | undefined, after: string): string =>
  before === undefined || before === ''
    ? `${label}: ${after === '' ? '(empty)' : quote(after)}`
    : `${label}: ${quote(before)} → ${after === '' ? '(cleared)' : quote(after)}`;

export const textLine = (label: string, value: string): string => `${label}: ${oneLine(value)}`;

export const summarize = (
  title: string,
  lines: ReadonlyArray<string | false | undefined>,
): RequestSummary => ({
  lines: lines.filter((line): line is string => typeof line === 'string'),
  title,
});

export const titled = (verb: string, noun: string, title: string): string =>
  `${verb} ${noun} ${quote(title)}`;

/** Whether two summaries describe the same write — what an approval is checked against. */
export const sameSummary = (a: RequestSummary, b: RequestSummary): boolean =>
  a.title === b.title &&
  a.lines.length === b.lines.length &&
  a.lines.every((line, index) => line === b.lines[index]);
