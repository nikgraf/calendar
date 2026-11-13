import { Temporal } from '@calendar/core';
import { saidDate, WEEKDAY_CODES, type WeekdayCode } from '@calendar/ai';

/**
 * How a practice phrase gave its day, asked of the teacher a second
 * time, and the answer to learn written that way. The teacher's first
 * answer holds a whole date; whether the words said "the 14th", "March
 * 14" or "in two weeks" cannot be told from it, so a short second
 * question asks only that, and which weekdays a repeat rules out. What
 * it says is used where it agrees with the first answer on the day, and
 * left out where it does not: the teacher decides what was said, the
 * code in `said.ts` which day that is.
 */

export const SAID_SCHEMA = {
  additionalProperties: false,
  properties: {
    amount: { type: 'number' },
    dayOfMonth: { type: 'number' },
    except: { items: { enum: [...WEEKDAY_CODES], type: 'string' }, type: 'array' },
    how: { enum: ['number', 'offset', 'other'], type: 'string' },
    month: { type: 'number' },
    unit: { enum: ['day', 'week', 'month', 'year'], type: 'string' },
    year: { type: 'number' },
  },
  required: ['except', 'how'],
  type: 'object',
} as const;

const QUESTIONS: ReadonlyArray<string> = [
  '1. how: the way the words give the day it is on (for a span of days, its first day).',
  '- "number": as a calendar date by its number: a day of the month, with or without the month and the year ("on the 22nd", "March 3", "12.3.", "am zwölften Juni", "Thursday the 6th", "by the 20th"). Give dayOfMonth, and month and year only when the words say them.',
  '- "offset": as an amount of time counted from today ("in three days", "in two weeks", "in einem halben Jahr", "heute in einer Woche"). Give amount and unit; half a year is 6 months.',
  '- "other": any other way, or not at all: a weekday, today, tomorrow, "next week", "this weekend", "end of the month", a day counted from another day ("two days before the 22nd", "a week from Friday"), a number that is only the end of a repeat or the day of a notification, or the days of a repeat ("every first Friday").',
  '2. except: the weekdays the words take out of a repeat with a word for it (except, but not, without, skip, drop, just not, außer, ohne, nur … nicht), as MO TU WE TH FR SA SU ("weekdays but not Wednesday" is WE; "täglich außer am Wochenende" is SA and SU). A repeat that only names its days takes none out: "weekdays", "Monday to Friday", "werktags" and "every Tuesday" give an empty list. Empty too when nothing repeats.',
];

export const SAID_PHRASE_MARKER = 'Phrase: ';
export const SAID_CHANGE_MARKER = 'Now: ';

/** The second question for a turn: the first phrase, or what is said to a draft. */
export const buildSaidPrompt = ({
  earlier,
  text,
}: {
  readonly earlier: ReadonlyArray<string>;
  readonly text: string;
}): string =>
  earlier.length === 0
    ? [
        'Someone typed or dictated one phrase to add something to their calendar. Do not work',
        'out any date. Answer two things about the wording.',
        ...QUESTIONS,
        `${SAID_PHRASE_MARKER}${text}`,
      ].join('\n')
    : [
        'Someone is adding something to their calendar by talking. Below are what they said',
        'before and what they say now. Do not work out any date. Answer two things about the',
        'wording of what they say now, and only that: words that give no new day are "other",',
        'and a weekday counts as ruled out only when the words said now rule it out.',
        ...QUESTIONS,
        `Said before: ${JSON.stringify(earlier)}`,
        `${SAID_CHANGE_MARKER}${text}`,
      ].join('\n');

/** How the words gave the day. */
export type SaidDay =
  | {
      readonly dayOfMonth: number;
      readonly how: 'number';
      readonly month?: number;
      readonly year?: number;
    }
  | { readonly amount: number; readonly how: 'offset'; readonly unit: 'd' | 'm' | 'w' | 'y' }
  | { readonly how: 'other' };

export interface Said {
  readonly day: SaidDay;
  readonly except: ReadonlyArray<WeekdayCode>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const wholeIn = (value: unknown, low: number, high: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high
    ? value
    : undefined;

const UNIT_LETTERS = { day: 'd', month: 'm', week: 'w', year: 'y' } as const;

const dayOf = (answer: Readonly<Record<string, unknown>>): SaidDay => {
  if (answer['how'] === 'number') {
    const dayOfMonth = wholeIn(answer['dayOfMonth'], 1, 31);
    const month = wholeIn(answer['month'], 1, 12);
    const year = wholeIn(answer['year'], 1900, 2200);
    return dayOfMonth === undefined
      ? { how: 'other' }
      : {
          dayOfMonth,
          how: 'number',
          ...(month === undefined ? {} : { month }),
          // A year without its month says nothing a date can be written from.
          ...(month === undefined || year === undefined ? {} : { year }),
        };
  }
  if (answer['how'] === 'offset') {
    const amount = wholeIn(answer['amount'], 0, 999);
    const unit = Object.entries(UNIT_LETTERS).find(([name]) => name === answer['unit'])?.[1];
    return amount === undefined || unit === undefined
      ? { how: 'other' }
      : { amount, how: 'offset', unit };
  }
  return { how: 'other' };
};

/** The teacher's second answer, held to what it may say. Undefined for one that is no answer. */
export const saidOf = (answer: unknown): Said | undefined => {
  if (!isRecord(answer)) {
    return undefined;
  }
  const named = Array.isArray(answer['except']) ? answer['except'] : [];
  return {
    day: dayOf(answer),
    except: WEEKDAY_CODES.filter((code) => named.includes(code)),
  };
};

const two = (value: number): string => String(value).padStart(2, '0');

/** The day as the tuned model is to write it, or undefined where it is written whole. */
const writtenDay = (day: SaidDay): string | undefined => {
  if (day.how === 'number') {
    if (day.month === undefined) {
      return two(day.dayOfMonth);
    }
    return day.year === undefined ? `${two(day.month)}-${two(day.dayOfMonth)}` : undefined;
  }
  return day.how === 'offset' ? `+${String(day.amount)}${day.unit}` : undefined;
};

/** Whether what was said fits the date the teacher gave: the same day, and month where one was said. */
const fitsDate = (
  day: SaidDay,
  written: string,
  { date, draftDate, referenceDate }: AsSaidContext & { readonly date: string },
): boolean => {
  const given = Temporal.PlainDate.from(date);
  if (day.how === 'number') {
    return given.day === day.dayOfMonth && (day.month === undefined || given.month === day.month);
  }
  // An amount is exact: the code's sum is the teacher's date, or the amount is not what set it.
  return saidDate(written, { from: referenceDate, near: draftDate }) === date;
};

interface AsSaidContext {
  readonly draftDate?: string | undefined;
  readonly referenceDate: string;
}

const realDate = (value: unknown): string | undefined =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? saidDate(value, { from: value })
    : undefined;

/**
 * The repeat with the ruled-out days beside the rule they are taken
 * from: the teacher's days and the ruled-out ones together are the rule
 * as said ("weekdays" for Monday to Thursday with Friday ruled out), all
 * seven are "daily". Undefined where the teacher's rule has no weekdays
 * to go by.
 */
const repeatAsSaid = (
  repeat: Readonly<Record<string, unknown>>,
  except: ReadonlyArray<WeekdayCode>,
): Record<string, unknown> | undefined => {
  const listed = Array.isArray(repeat['byDay']) ? repeat['byDay'].map(String) : [];
  const plain = listed.every((day) => WEEKDAY_CODES.some((code) => code === day));
  if (!plain || (repeat['freq'] !== 'weekly' && repeat['freq'] !== 'daily')) {
    return undefined;
  }
  if (repeat['freq'] === 'weekly' && listed.length === 0) {
    return undefined;
  }
  const said = WEEKDAY_CODES.filter(
    (code) => repeat['freq'] === 'daily' || listed.includes(code) || except.includes(code),
  );
  const { byDay: _days, ...rest } = repeat;
  return said.length === WEEKDAY_CODES.length
    ? { ...rest, except, freq: 'daily' }
    : { ...rest, byDay: said, except, freq: 'weekly' };
};

/** What `asSaid` changed, for a count of the data. */
export type SaidForm = 'day' | 'except' | 'monthDay' | 'offset';

/**
 * The teacher's answer with its day and its repeat written as said,
 * where the second answer fits the first, and what was rewritten. An
 * answer the second one does not fit is returned as it is: a whole date
 * the teacher worked out stays one.
 */
export const asSaid = (
  answer: Readonly<Record<string, unknown>>,
  said: Said | undefined,
  context: AsSaidContext,
): { readonly answer: Record<string, unknown>; readonly forms: ReadonlyArray<SaidForm> } => {
  if (said === undefined) {
    return { answer: { ...answer }, forms: [] };
  }
  const forms: Array<SaidForm> = [];
  let rewritten: Record<string, unknown> = { ...answer };
  const date = realDate(answer['date']);
  const written = writtenDay(said.day);
  if (
    date !== undefined &&
    written !== undefined &&
    fitsDate(said.day, written, { ...context, date })
  ) {
    rewritten = { ...rewritten, date: written };
    forms.push(said.day.how === 'offset' ? 'offset' : written.includes('-') ? 'monthDay' : 'day');
  }
  const { repeat } = answer;
  if (said.except.length > 0 && isRecord(repeat)) {
    const rule = repeatAsSaid(repeat, said.except);
    if (rule !== undefined) {
      rewritten = { ...rewritten, repeat: rule };
      forms.push('except');
    }
  }
  return { answer: rewritten, forms };
};
