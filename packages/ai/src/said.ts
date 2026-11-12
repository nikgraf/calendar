import { Temporal } from '@calendar/core';

/**
 * A day and a repeat as the words gave them, and the code that works
 * them out. A model trained for the tuned arm writes a date it cannot
 * look up in the days it is shown the way it was said ("14" for "on the
 * 14th", "03-14" for "March 14", "+2w" for "in two weeks") and a repeat
 * with the weekdays the words ruled out beside it; which year a date
 * falls in and which weekdays are left is arithmetic, done here. Nothing
 * in this file reads a phrase.
 */

export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

const FULL = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH_DAY = /^(\d{1,2})-(\d{1,2})$/u;
const DAY = /^\d{1,2}$/u;
const OFFSET = /^\+(\d{1,3})([dmwy])$/u;

/** How far ahead a date without its year is looked for: a 29 February is at most eight years off. */
const YEARS_AHEAD = 8;
const MONTHS_AHEAD = 12;

const dateAt = (year: number, month: number, day: number): Temporal.PlainDate | undefined => {
  try {
    return Temporal.PlainDate.from({ day, month, year }, { overflow: 'reject' });
  } catch {
    return undefined;
  }
};

const fullDate = (text: string): string | undefined => {
  try {
    return Temporal.PlainDate.from(text, { overflow: 'reject' }).toString();
  } catch {
    return undefined;
  }
};

const onOrAfter = (date: Temporal.PlainDate | undefined, from: Temporal.PlainDate): boolean =>
  date !== undefined && Temporal.PlainDate.compare(date, from) >= 0;

/** The next such day of a year on or after `from`. */
const nextMonthDay = (month: number, day: number, from: Temporal.PlainDate): string | undefined =>
  Array.from({ length: YEARS_AHEAD + 1 }, (_, index) => dateAt(from.year + index, month, day))
    .find((date) => onOrAfter(date, from))
    ?.toString();

/**
 * The next such day of a month on or after `from`. A draft's own month
 * comes first: "actually the 15th" said to a wedding in March stays in
 * March.
 */
const nextDay = (
  day: number,
  from: Temporal.PlainDate,
  near: Temporal.PlainDate | undefined,
): string | undefined => {
  const inDraftMonth = near === undefined ? undefined : dateAt(near.year, near.month, day);
  if (inDraftMonth !== undefined && onOrAfter(inDraftMonth, from)) {
    return inDraftMonth.toString();
  }
  const first = from.with({ day: 1 });
  return Array.from({ length: MONTHS_AHEAD + 1 }, (_, index) => {
    const month = first.add({ months: index });
    return dateAt(month.year, month.month, day);
  })
    .find((date) => onOrAfter(date, from))
    ?.toString();
};

const UNITS = { d: 'days', m: 'months', w: 'weeks', y: 'years' } as const;

/**
 * The date a model wrote, as a real day: a whole date as it is, a month
 * and day ("03-14") or a day alone ("14") as the next one on or after
 * `from`, an amount ("+2w", "+6m") counted from `from`. Undefined for
 * anything else, and for a day no calendar has.
 */
export const saidDate = (
  value: unknown,
  { from, near }: { readonly from: string; readonly near?: string | undefined },
): string | undefined => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  const written = text.trim();
  if (FULL.test(written)) {
    return fullDate(written);
  }
  const start = Temporal.PlainDate.from(from);
  const monthDay = MONTH_DAY.exec(written);
  if (monthDay !== null) {
    return nextMonthDay(Number(monthDay[1]), Number(monthDay[2]), start);
  }
  if (DAY.test(written)) {
    return nextDay(
      Number(written),
      start,
      near === undefined ? undefined : Temporal.PlainDate.from(near),
    );
  }
  const offset = OFFSET.exec(written);
  if (offset !== null) {
    const unit = UNITS[offset[2] as keyof typeof UNITS];
    return start.add({ [unit]: Number(offset[1]) }).toString();
  }
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const codesIn = (value: unknown): ReadonlyArray<WeekdayCode> => {
  const said = Array.isArray(value) ? value.map((day) => String(day).trim().toUpperCase()) : [];
  return WEEKDAY_CODES.filter((code) => said.includes(code));
};

/**
 * A repeat with its ruled-out weekdays taken off: every day but some is
 * a weekly rule on the days left, a weekly rule loses the days named.
 * Where nothing would be left, or the rule has no days to take from, the
 * rule stands as it was written.
 */
export const withoutRuledOut = (
  repeat: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const { except, ...rule } = repeat;
  const ruledOut = codesIn(except);
  if (ruledOut.length === 0) {
    return rule;
  }
  const listed = Array.isArray(rule['byDay']) ? rule['byDay'].map(String) : [];
  const base = rule['freq'] === 'daily' && listed.length === 0 ? [...WEEKDAY_CODES] : listed;
  const left = base.filter((day) => !ruledOut.some((code) => code === day.trim().toUpperCase()));
  if (left.length === 0 || left.length === base.length) {
    return rule;
  }
  if (rule['freq'] !== 'daily' && rule['freq'] !== 'weekly') {
    return rule;
  }
  return { ...rule, byDay: left, freq: 'weekly' };
};

/**
 * A tuned model's answer with its day and its repeat worked out: what
 * the plain arm's code takes. `draftDate` is the day of the draft a
 * later turn changes. A date that cannot be read is left as written,
 * for the code after this to turn down.
 */
export const worked = (
  answer: unknown,
  {
    draftDate,
    referenceDate,
  }: { readonly draftDate?: string | undefined; readonly referenceDate: string },
): unknown => {
  if (!isRecord(answer)) {
    return answer;
  }
  const date = saidDate(answer['date'], { from: referenceDate, near: draftDate });
  const { repeat } = answer;
  if (!isRecord(repeat)) {
    return date === undefined ? answer : { ...answer, date };
  }
  const rule = withoutRuledOut(repeat);
  // A repeat's end is on or after the day it starts on.
  const until = saidDate(rule['untilDate'], { from: date ?? draftDate ?? referenceDate });
  return {
    ...answer,
    ...(date === undefined ? {} : { date }),
    repeat: until === undefined ? rule : { ...rule, untilDate: until },
  };
};
