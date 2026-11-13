import { Temporal } from '@calendar/core';

/**
 * A day and a repeat as the words gave them, and the code that works
 * them out. A model trained for the tuned arm writes a date it cannot
 * look up in the days it is shown the way it was said ("14" for "on the
 * 14th", "03-14" for "March 14", "+2w" for "in two weeks") and a repeat
 * with the weekdays the words ruled out beside it, and a time as an
 * amount where the words gave one ("+30m" for "half an hour later",
 * "45m" for "for 45 minutes"); which year a date falls in, which weekdays
 * are left and which clock time an amount comes to is arithmetic, done
 * here. Nothing in this file reads a phrase.
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

const DAY_MINUTES = 24 * 60;
const CLOCK = /^(\d{1,2}):(\d{2})$/u;
/** Hours, minutes or both ("1h", "45m", "1h30m", "45min"); a sign in front makes it a shift. */
const AMOUNT = /^([+-])?(?=\d)(?:(\d{1,2})h)?(?:(\d{1,4})m(?:in)?)?$/u;

/** A time written with a sign: meant as a shift, whether or not it reads as one. */
const signed = (value: unknown): boolean => typeof value === 'string' && /^\s*[+-]/u.test(value);

/** A time an amount says: a shift of the draft's time, or a length from the start. */
interface Amount {
  readonly minutes: number;
  readonly shift: boolean;
}

const amountOf = (value: unknown): Amount | undefined => {
  const match = typeof value === 'string' ? AMOUNT.exec(value.trim()) : null;
  if (match === null) {
    return undefined;
  }
  const minutes = Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return { minutes: match[1] === '-' ? -minutes : minutes, shift: match[1] !== undefined };
};

/** An amount within a day; a length is more than nothing. */
const fits = (amount: Amount | undefined): boolean =>
  amount === undefined ||
  (Math.abs(amount.minutes) < DAY_MINUTES && (amount.shift || amount.minutes > 0));

const clockMinutes = (value: unknown): number | undefined => {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  if (match === null) {
    return undefined;
  }
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  return hour < 24 && minute < 60 ? hour * 60 + minute : undefined;
};

const two = (value: number): string => String(value).padStart(2, '0');

const clockOf = (minutes: number): string => {
  const within = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${two(Math.floor(within / 60))}:${two(within % 60)}`;
};

/** An amount as a tuned model is trained to write it: whole hours in hours, else minutes. */
export const writtenAmount = (minutes: number, { shift }: { readonly shift: boolean }): string => {
  const sign = shift ? (minutes < 0 ? '-' : '+') : '';
  const size = Math.abs(minutes);
  return `${sign}${size > 0 && size % 60 === 0 ? `${String(size / 60)}h` : `${String(size)}m`}`;
};

/** The times of the draft a later turn changes. */
export interface DraftTimes {
  readonly date: string;
  readonly endTime: string;
  readonly isAllDay: boolean;
  readonly startTime: string;
}

/**
 * A tuned model's answer with its times worked out: a start written as a
 * shift ("+30m", "-1h") is the draft's start moved by it, an end written
 * as a shift the draft's end moved, an end written as a length ("45m")
 * that long after the start. A start moved past midnight moves the day
 * with it. Clock times and anything else are left as written. Undefined,
 * an answer to turn down, where an amount cannot be worked out: a shift
 * without a timed draft or that reads as none, a length without a start,
 * a start as a length, or a day or more.
 */
export const workedTimes = (
  answer: unknown,
  { draft }: { readonly draft?: DraftTimes | undefined },
): unknown => {
  if (!isRecord(answer)) {
    return answer;
  }
  const start = amountOf(answer['startTime']);
  const end = amountOf(answer['endTime']);
  // A shift that reads as none ("+1.5h") is turned down, not read as no time (all day).
  if (
    (start === undefined && signed(answer['startTime'])) ||
    (end === undefined && signed(answer['endTime']))
  ) {
    return undefined;
  }
  if (start === undefined && end === undefined) {
    return answer;
  }
  const timed = draft !== undefined && !draft.isAllDay ? draft : undefined;
  if (!fits(start) || !fits(end) || (start !== undefined && !start.shift)) {
    return undefined;
  }
  let startMinutes = clockMinutes(answer['startTime']);
  let days = 0;
  if (start !== undefined) {
    const from = clockMinutes(timed?.startTime);
    if (from === undefined) {
      return undefined;
    }
    days = Math.floor((from + start.minutes) / DAY_MINUTES);
    startMinutes = from + start.minutes - days * DAY_MINUTES;
  }
  let endMinutes: number | undefined;
  if (end !== undefined) {
    const from = end.shift ? clockMinutes(timed?.endTime) : startMinutes;
    if (from === undefined) {
      return undefined;
    }
    endMinutes = from + end.minutes;
  }
  let date: string | undefined;
  if (days !== 0) {
    const on = answer['date'] === undefined ? timed?.date : answer['date'];
    const day = typeof on === 'string' && FULL.test(on) ? fullDate(on) : undefined;
    if (day === undefined) {
      return undefined;
    }
    date = Temporal.PlainDate.from(day).add({ days }).toString();
  }
  return {
    ...answer,
    ...(date === undefined ? {} : { date }),
    ...(endMinutes === undefined ? {} : { endTime: clockOf(endMinutes) }),
    ...(start === undefined || startMinutes === undefined
      ? {}
      : { startTime: clockOf(startMinutes) }),
  };
};
