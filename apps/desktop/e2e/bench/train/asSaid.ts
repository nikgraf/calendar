import { Temporal } from '@calendar/core';
import { saidDate, WEEKDAY_CODES, type WeekdayCode, writtenAmount } from '@calendar/ai';

/**
 * How a practice phrase gave its day and its times, asked of the teacher
 * a second time, and the answer to learn written that way. The teacher's
 * first answer holds a whole date and clock times; whether the words
 * said "the 14th", "in two weeks" or no day at all, "half an hour later"
 * or "for 45 minutes" cannot be told from it, so a short second question
 * asks only that, and which weekdays a repeat rules out. What it says is
 * used where it agrees with the first answer, and left out where it does
 * not: the teacher decides what was said, the code in `said.ts` which
 * day and which clock time that is.
 */

export const SAID_SCHEMA = {
  additionalProperties: false,
  properties: {
    amount: { type: 'number' },
    dayOfMonth: { type: 'number' },
    end: { enum: ['clock', 'length', 'longer', 'shorter', 'other'], type: 'string' },
    endMinutes: { type: 'number' },
    except: { items: { enum: [...WEEKDAY_CODES], type: 'string' }, type: 'array' },
    how: { enum: ['number', 'offset', 'other', 'none'], type: 'string' },
    month: { type: 'number' },
    noAlert: { type: 'boolean' },
    start: { enum: ['clock', 'later', 'earlier', 'other'], type: 'string' },
    startMinutes: { type: 'number' },
    unit: { enum: ['day', 'week', 'month', 'year'], type: 'string' },
    year: { type: 'number' },
  },
  required: ['except', 'how', 'start', 'end', 'noAlert'],
  type: 'object',
} as const;

const QUESTIONS: ReadonlyArray<string> = [
  '1. how: the way the words give the day it is on (for a span of days, its first day).',
  '- "number": as a calendar date by its number: a day of the month, with or without the month and the year ("on the 22nd", "March 3", "12.3.", "am zwölften Juni", "Thursday the 6th", "by the 20th"). Give dayOfMonth, and month and year only when the words say them.',
  '- "offset": as an amount of time counted from today ("in three days", "in two weeks", "in einem halben Jahr", "heute in einer Woche"). Give amount and unit; half a year is 6 months.',
  '- "other": any other way: a weekday, today, tomorrow, "next week", "this weekend", "end of the month", a day counted from another day ("two days before the 22nd", "a week from Friday"), or the days of a repeat ("every first Friday").',
  '- "none": the words say nothing about which day: no date, no weekday, no "today" or "tomorrow". A number that is only a time, the end of a repeat or the day of a notification says no day.',
  '2. except: the weekdays the words take out of a repeat with a word for it (except, but not, without, skip, drop, just not, außer, ohne, nur … nicht), as MO TU WE TH FR SA SU ("weekdays but not Wednesday" is WE; "täglich außer am Wochenende" is SA and SU). A repeat that only names its days takes none out: "weekdays", "Monday to Friday", "werktags" and "every Tuesday" give an empty list. Empty too when nothing repeats.',
  '3. start: the way the words give the start time.',
  '- "later" or "earlier": as an amount the start moves by ("half an hour later", "push it back 20 minutes", "eine Stunde früher"). Give startMinutes, the amount in minutes.',
  '- "clock": as a time of day ("at 5", "um halb acht", "from 9", "noon"), or a meal or part of the day.',
  '- "other": no start time in the words.',
  '4. end: the way the words give the end.',
  '- "length": as how long it lasts ("for 45 minutes", "two hours long", "make it 90 minutes", "eine halbe Stunde lang"). Give endMinutes, the length in minutes.',
  '- "longer" or "shorter": as an amount the end moves by while the start stays ("ten minutes longer", "eine Viertelstunde kürzer"). Give endMinutes, the amount in minutes.',
  '- "clock": as a time of day ("until 6", "to 11", "bis 17 Uhr").',
  '- "other": no end in the words, also when the whole thing moves later or earlier.',
  '5. noAlert: true only when the words ask for no notification or reminder at all, or to turn them all off ("without an alert", "keine Benachrichtigung"). False otherwise, also when they say nothing about notifications.',
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
        'out any date or time. Answer five things about the wording.',
        ...QUESTIONS,
        `${SAID_PHRASE_MARKER}${text}`,
      ].join('\n')
    : [
        'Someone is adding something to their calendar by talking. Below are what they said',
        'before and what they say now. Do not work out any date or time. Answer five things about',
        'the wording of what they say now, and only that: words that say nothing about the day',
        'are "none", a weekday counts as ruled out only when the words said now rule it out, and',
        'a time counts only when the words said now give it.',
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
  | { readonly how: 'none' }
  | { readonly how: 'other' };

/** How the words gave a time: an amount it moves by (minutes, earlier ones below zero), a length, or neither. */
export type SaidTime =
  | { readonly how: 'length'; readonly minutes: number }
  | { readonly how: 'shift'; readonly minutes: number }
  | { readonly how: 'other' };

export interface Said {
  readonly day: SaidDay;
  readonly end?: SaidTime | undefined;
  readonly except: ReadonlyArray<WeekdayCode>;
  /** The words ask for no notification at all. */
  readonly noAlert?: boolean | undefined;
  readonly start?: SaidTime | undefined;
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
  return answer['how'] === 'none' ? { how: 'none' } : { how: 'other' };
};

/** Less than a day, more than nothing. */
const DAY_MINUTES = 24 * 60;

const timeOf = (how: unknown, value: unknown): SaidTime => {
  const minutes = wholeIn(value, 1, DAY_MINUTES - 1);
  if (minutes === undefined) {
    return { how: 'other' };
  }
  if (how === 'later' || how === 'longer') {
    return { how: 'shift', minutes };
  }
  if (how === 'earlier' || how === 'shorter') {
    return { how: 'shift', minutes: -minutes };
  }
  return how === 'length' ? { how: 'length', minutes } : { how: 'other' };
};

/** The teacher's second answer, held to what it may say. Undefined for one that is no answer. */
export const saidOf = (answer: unknown): Said | undefined => {
  if (!isRecord(answer)) {
    return undefined;
  }
  const named = Array.isArray(answer['except']) ? answer['except'] : [];
  return {
    day: dayOf(answer),
    end: timeOf(answer['end'], answer['endMinutes']),
    except: WEEKDAY_CODES.filter((code) => named.includes(code)),
    noAlert: answer['noAlert'] === true,
    start: timeOf(answer['start'], answer['startMinutes']),
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
  /** The times of the draft a later turn changes; none where it is all day. */
  readonly draftTimes?: { readonly endTime: string; readonly startTime: string } | undefined;
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
export type SaidForm =
  | 'day'
  | 'except'
  | 'length'
  | 'monthDay'
  | 'noAlert'
  | 'noDay'
  | 'offset'
  | 'shift';

/**
 * The notifications as said: none where the words ask for none (an
 * empty list, which a first phrase keeps: `tunedAnswer`), and no empty
 * list where they do not; a teacher writes one for words that say
 * nothing about notifications, and the code would read it as "none".
 * A list the teacher filled stays.
 */
const remindersAsSaid = (
  answer: Readonly<Record<string, unknown>>,
  said: Said | undefined,
): { readonly answer: Record<string, unknown>; readonly noAlert: boolean } => {
  const { reminders } = answer;
  const empty = reminders === undefined || (Array.isArray(reminders) && reminders.length === 0);
  if (!empty) {
    return { answer: { ...answer }, noAlert: false };
  }
  const { reminders: _none, ...rest } = answer;
  return said?.noAlert === true
    ? { answer: { ...rest, reminders: [] }, noAlert: true }
    : { answer: rest, noAlert: false };
};

const clockMinutes = (value: unknown): number | undefined => {
  const match = typeof value === 'string' ? /^(\d{2}):(\d{2})$/u.exec(value) : null;
  return match === null ? undefined : Number(match[1]) * 60 + Number(match[2]);
};

const sameClock = (a: number, b: number): boolean =>
  (((a - b) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES === 0;

/**
 * The times written as said where the second answer fits the first: a
 * start moved by the amount said is the draft's start moved by it (and
 * an end that moved with it is written the same way); an end as a length
 * is that long after the teacher's start; an end moved by an amount, the
 * start kept, is the draft's end moved by it. A start moved past
 * midnight stays a clock time: its day is the teacher's.
 */
const timesAsSaid = (
  answer: Readonly<Record<string, unknown>>,
  said: Said,
  draft: AsSaidContext['draftTimes'],
): { readonly forms: ReadonlyArray<SaidForm>; readonly times: Record<string, string> } => {
  const start = clockMinutes(answer['startTime']);
  const end = clockMinutes(answer['endTime']);
  const draftStart = clockMinutes(draft?.startTime);
  const draftEnd = clockMinutes(draft?.endTime);
  const times: Record<string, string> = {};
  const forms: Array<SaidForm> = [];
  if (said.start?.how === 'shift' && start !== undefined && draftStart !== undefined) {
    const moved = draftStart + said.start.minutes;
    if (moved >= 0 && moved < DAY_MINUTES && moved === start) {
      const written = writtenAmount(said.start.minutes, { shift: true });
      times['startTime'] = written;
      if (
        end !== undefined &&
        draftEnd !== undefined &&
        sameClock(draftEnd + said.start.minutes, end)
      ) {
        times['endTime'] = written;
      }
      forms.push('shift');
    }
  }
  if (said.end?.how === 'length' && start !== undefined && end !== undefined) {
    if (sameClock(start + said.end.minutes, end)) {
      times['endTime'] = writtenAmount(said.end.minutes, { shift: false });
      forms.push('length');
    }
  } else if (
    said.end?.how === 'shift' &&
    end !== undefined &&
    draftEnd !== undefined &&
    start === draftStart &&
    sameClock(draftEnd + said.end.minutes, end)
  ) {
    times['endTime'] = writtenAmount(said.end.minutes, { shift: true });
    forms.push('shift');
  }
  return { forms: [...new Set(forms)], times };
};

/**
 * The teacher's answer with its day, its times and its repeat written as
 * said, where the second answer fits the first, and what was rewritten.
 * An answer the second one does not fit is returned as it is: a whole
 * date or a clock time the teacher worked out stays one.
 */
export const asSaid = (
  answer: Readonly<Record<string, unknown>>,
  said: Said | undefined,
  context: AsSaidContext,
): { readonly answer: Record<string, unknown>; readonly forms: ReadonlyArray<SaidForm> } => {
  const alerts = remindersAsSaid(answer, said);
  if (said === undefined) {
    return { answer: alerts.answer, forms: [] };
  }
  const forms: Array<SaidForm> = alerts.noAlert ? ['noAlert'] : [];
  let rewritten: Record<string, unknown> = alerts.answer;
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
  // No day said: none written, where the teacher's is the one the code takes (today, or the draft's).
  if (
    said.day.how === 'none' &&
    date !== undefined &&
    date === (context.draftDate ?? context.referenceDate)
  ) {
    const { date: _unsaid, ...undated } = rewritten;
    rewritten = undated;
    forms.push('noDay');
  }
  const timed = timesAsSaid(answer, said, context.draftTimes);
  rewritten = { ...rewritten, ...timed.times };
  forms.push(...timed.forms);
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
