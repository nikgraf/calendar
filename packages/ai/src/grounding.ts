import { finderWindowDates, foldSearchText, Temporal } from '@calendar/core';

/**
 * What the phrase itself says, read deterministically and held against
 * what the model returned.
 *
 * The on-device model is trusted for extraction only — and in practice it
 * fills every optional field: a time for every meal ("dinner with Teo"
 * came back at 13:00), 00:00 with isAllDay false for a phrase that named
 * no time, a Tuesday in every finder answer, "task" for a lunch. So the
 * normalizers keep a model value only where the phrase supports it,
 * correct one the phrase contradicts, and drop the rest. The words are
 * English and German; a phrase in another language falls back to the safe
 * reading (all day, any day), never to the model's guess. Where the code
 * can see that it cannot read a construction (a negation, a window with
 * two ends, "before lunch", "two weeks from today", "two days after
 * Monday"), it has no opinion and the model's answer stands.
 */

/** Lower-case, accent-free text with straight apostrophes and "ss" for ß: what every pattern here is matched against. */
const words = (phrase: string): string =>
  foldSearchText(phrase)
    .replaceAll(/[‘’`]/g, "'")
    .replaceAll('ß', 'ss');

/**
 * Something ruled out ("not in the morning", "any day but Tuesday",
 * "außer Dienstag"): the words after it are named without being meant,
 * which the code does not read.
 */
const NEGATION = /\b(?:not|except|but|other than|nicht|ausser|ohne|keine?n?)\b/;

// --- Meals and parts of the day ------------------------------------------

export type Period =
  | 'afternoon'
  | 'breakfast'
  | 'brunch'
  | 'dinner'
  | 'evening'
  | 'lunch'
  | 'morning'
  | 'night';

export interface PeriodTimes {
  /** The finder's daily bounds for the period. */
  readonly earliestTime: string;
  readonly latestTime: string;
  /** Where quick-add puts an event that names the period and no clock time. */
  readonly startTime: string;
}

/**
 * Meals first: "dinner tonight" is dinner. Morning, afternoon and evening
 * share the finder's preset bounds, so a phrase lights the preset up.
 * German "morgen" is left out on purpose — folded, it is also "tomorrow".
 */
const PERIODS: ReadonlyArray<{
  readonly names: string;
  readonly period: Period;
  readonly times: PeriodTimes;
}> = [
  {
    names: 'breakfast|fruhstuck',
    period: 'breakfast',
    times: { earliestTime: '07:00', latestTime: '10:00', startTime: '08:00' },
  },
  {
    names: 'brunch',
    period: 'brunch',
    times: { earliestTime: '10:00', latestTime: '13:00', startTime: '11:00' },
  },
  {
    names: 'lunch(?:time)?|mittag\\w*',
    period: 'lunch',
    times: { earliestTime: '11:30', latestTime: '14:00', startTime: '12:30' },
  },
  {
    names: 'dinner|supper|abendessen',
    period: 'dinner',
    times: { earliestTime: '18:00', latestTime: '21:00', startTime: '19:00' },
  },
  {
    names: 'mornings?|vormittags?',
    period: 'morning',
    times: { earliestTime: '08:00', latestTime: '12:00', startTime: '09:00' },
  },
  {
    names: 'afternoons?|nachmittags?',
    period: 'afternoon',
    times: { earliestTime: '12:00', latestTime: '17:00', startTime: '14:00' },
  },
  {
    names: 'evenings?|tonight|abends?|feierabend|after work|nach der arbeit',
    period: 'evening',
    times: { earliestTime: '17:00', latestTime: '21:00', startTime: '18:00' },
  },
  {
    names: 'nights?|nachts?',
    period: 'night',
    times: { earliestTime: '19:00', latestTime: '23:00', startTime: '20:00' },
  },
];

const PERIOD_NAMES = PERIODS.map((entry) => entry.names).join('|');

/**
 * A meal or part of the day used as a boundary ("before lunch", "after
 * dinner", "nach dem Mittagessen"): not the time itself, and not a window
 * the code can place.
 */
const PERIOD_AS_BOUND = new RegExp(
  `\\b(?:before|after|until|till|bis|vor|nach|ab)\\s+(?:the\\s+|dem\\s+|der\\s+)?(?:${PERIOD_NAMES})`,
);

/** A named period the code cannot place: a boundary, or ruled out. */
const periodUnreadable = (text: string): boolean =>
  PERIOD_AS_BOUND.test(text) || NEGATION.test(text);

/** The meal or part of the day the phrase names, if any. */
export const periodOf = (phrase: string): Period | undefined => {
  const text = words(phrase);
  return PERIODS.find((entry) => new RegExp(`\\b(?:${entry.names})\\b`).test(text))?.period;
};

export const periodTimes = (period: Period): PeriodTimes =>
  PERIODS.find((entry) => entry.period === period)!.times;

// --- Clock times ----------------------------------------------------------

export interface ClockTime {
  /** am/pm, a 24-hour hour, noon or midnight: nothing left to guess. */
  readonly exact: boolean;
  /** 24-hour when `exact`; otherwise as written, 0–12, with the half of the day still open. */
  readonly hour: number;
  readonly minute: number;
}

interface Found extends ClockTime {
  /** Written as where something ends ("to 4", "–16:00", "until 5pm", "before 10"). */
  readonly closes: boolean;
  readonly end: number;
  readonly index: number;
}

/**
 * German "ein" is not here — "um ein paar Dinge" names no time — and is
 * read only right before "Uhr".
 */
const NUMBER_WORDS = {
  acht: 8,
  drei: 3,
  eight: 8,
  eins: 1,
  eleven: 11,
  elf: 11,
  five: 5,
  four: 4,
  funf: 5,
  neun: 9,
  nine: 9,
  one: 1,
  sechs: 6,
  seven: 7,
  sieben: 7,
  six: 6,
  ten: 10,
  three: 3,
  twelve: 12,
  two: 2,
  vier: 4,
  zehn: 10,
  zwei: 2,
  zwolf: 12,
} as const;

const NUMBER_WORD = Object.keys(NUMBER_WORDS).join('|');
const NUMBER = `(\\d{1,2}|${NUMBER_WORD})`;
/** A number or a named hour, where either may stand: "from 8 to noon", "at midnight". */
const TOKEN = `(\\d{1,2}|${NUMBER_WORD}|noon|midday|midnight|mitternacht)`;
/**
 * German "am" is "on" ("um 7 am Montag", "am 17."), and a.m. never
 * precedes a day word or a day number; "pm" and the dotted forms are
 * never German, so "3pm 20 Oct" stays a time.
 */
const MERIDIEM = `(a\\.m\\.|am(?!\\s+(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|morgen|vormittag|mittag|nachmittag|abend|wochenende|ersten|\\d))|p\\.?m\\.?)`;
/** An optional unit after a number, as two groups: am/pm, or German "Uhr". */
const UNIT = `(?:\\s*${MERIDIEM}(?![a-z])|\\s*(uhr)\\b)?`;
/** The same unit, required. */
const SOME_UNIT = UNIT.slice(0, -1);
/** Where a time ends: no letter or digit may follow — unlike `\b`, true after "a.m." too. */
const END = String.raw`(?![a-z\d])`;
const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|januar|februar|marz|mai|juni|juli|oktober|dezember';
const LENGTH_UNITS = 'min|mins|minutes?|minuten|h|hr|hrs|hours?|stunden?|std';
/**
 * A bare number that is part of a date or a length of time is not a
 * clock: "17.10.", "17. Oktober", "17 October", "nach 2 Tagen", "um 5
 * Minuten". The number must end here too, or "18 October" would be read
 * back as "1" and the lookaheads skipped.
 */
const NOT_A_QUANTITY = `(?!\\d)(?![./]\\d)(?!\\.?\\s*(?:${MONTHS})\\b)(?!\\s*(?:${LENGTH_UNITS}|tagen?|days?|wochen?|weeks?)\\b)`;
const CLOSER = `(?:to|until|till|bis|and|und|-|–)`;

const numberOf = (token: string): number =>
  token === 'ein'
    ? 1
    : token in NUMBER_WORDS
      ? NUMBER_WORDS[token as keyof typeof NUMBER_WORDS]
      : Number(token);

const minutesOf = (token: string | undefined): number => (token === undefined ? 0 : Number(token));

const clock = (
  hour: number,
  minute: number,
  meridiem: string | undefined,
  closes = false,
): Found | undefined => {
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  if (meridiem !== undefined) {
    const pm = meridiem.startsWith('p');
    const resolved = hour === 12 ? (pm ? 12 : 0) : pm ? hour + 12 : hour;
    return { closes, end: 0, exact: true, hour: resolved, index: 0, minute };
  }
  return { closes, end: 0, exact: hour === 0 || hour > 12, hour, index: 0, minute };
};

/** A number or a named hour as a time. */
const clockOf = (
  token: string,
  minute: number,
  meridiem: string | undefined,
  closes = false,
): Found | undefined => {
  if (token === 'noon' || token === 'midday') {
    return clock(12, minute, 'pm', closes);
  }
  if (token === 'midnight' || token === 'mitternacht') {
    return clock(0, minute, undefined, closes);
  }
  return clock(numberOf(token), minute, meridiem, closes);
};

const minutes = ({ hour, minute }: ClockTime): number => hour * 60 + minute;

/**
 * A time some minutes before another: "quarter to twelve pm" is 12:00
 * resolved first, then 11:45 — never 11 resolved as 23. An open hour
 * stays open: "halb eins" is 0:30, which may mean 12:30.
 */
const shifted = (found: Found | undefined, by: number): Found | undefined => {
  if (!found) {
    return undefined;
  }
  const total = (minutes(found) + by + 24 * 60) % (24 * 60);
  return { ...found, hour: Math.floor(total / 60), minute: total % 60 };
};

/**
 * The start of a range whose end carries the unit: "from 9 to 5pm" is
 * 09:00–17:00, not 21:00; the end's half of the day is the start's only
 * when the start then comes first ("2-4pm").
 */
const rangeStart = (
  token: string,
  minute: number,
  meridiem: string | undefined,
  endMeridiem: string | undefined,
  end: Found | undefined,
): Found | undefined => {
  if (meridiem !== undefined) {
    return clockOf(token, minute, meridiem);
  }
  if (endMeridiem !== undefined && end) {
    const shared = clockOf(token, minute, endMeridiem);
    if (shared && minutes(shared) < minutes(end)) {
      return shared;
    }
  }
  return clockOf(token, minute, undefined);
};

/**
 * Every way a phrase states a clock time, in English or German. Each
 * pattern yields the times it names; a range yields its start and, as a
 * closer, its end. A compound ("half past two pm") consumes its unit, so
 * no fragment of it ("two pm") can outrank it.
 */
const PATTERNS: ReadonlyArray<{
  readonly build: (match: RegExpExecArray) => ReadonlyArray<Found | undefined>;
  readonly regex: RegExp;
}> = [
  // 13:00, 1:30pm, 8:30 Uhr
  {
    build: (match) => [clock(Number(match[1]), Number(match[2]), match[3])],
    regex: new RegExp(`\\b(\\d{1,2}):(\\d{2})${UNIT}`, 'g'),
  },
  // 14.30 Uhr — the dot form needs its unit, or it is a date
  {
    build: (match) => [clock(Number(match[1]), Number(match[2]), undefined)],
    regex: /\b(\d{1,2})\.(\d{2})\s*uhr\b/g,
  },
  // 1pm, 7 a.m., 19 Uhr, ein Uhr
  {
    build: (match) => [clock(numberOf(match[1]!), 0, match[2])],
    regex: new RegExp(`\\b(ein|\\d{1,2}|${NUMBER_WORD})${SOME_UNIT}`, 'g'),
  },
  // at 1, um 7, @7, at three, um drei, at 3pm, at noon — not "at 17.10." or "um 5 Minuten"
  {
    build: (match) => [clockOf(match[1]!, minutesOf(match[2]), match[3])],
    regex: new RegExp(
      `(?:\\b(?:at|um)|@)\\s*${TOKEN}(?::(\\d{2}))?${NOT_A_QUANTITY}${UNIT}${END}`,
      'g',
    ),
  },
  // after 5, nach 17 Uhr, ab 9: a time something starts from
  {
    build: (match) => [clockOf(match[1]!, minutesOf(match[2]), match[3])],
    regex: new RegExp(
      `\\b(?:after|nach|ab)\\s+${TOKEN}(?::(\\d{2}))?${NOT_A_QUANTITY}${UNIT}${END}`,
      'g',
    ),
  },
  // before 10, vor 17 Uhr: a time something ends by
  {
    build: (match) => [clockOf(match[1]!, minutesOf(match[2]), match[3], true)],
    regex: new RegExp(
      `\\b(?:before|vor)\\s+${TOKEN}(?::(\\d{2}))?${NOT_A_QUANTITY}${UNIT}${END}`,
      'g',
    ),
  },
  // half past two (pm)
  {
    build: (match) => [clock(numberOf(match[1]!), 30, match[2])],
    regex: new RegExp(`\\bhalf past ${NUMBER}${UNIT}${END}`, 'g'),
  },
  // halb drei (half to three: 2:30)
  {
    build: (match) => [shifted(clock(numberOf(match[1]!), 0, match[2]), -30)],
    regex: new RegExp(`\\bhalb ${NUMBER}${UNIT}${END}`, 'g'),
  },
  // quarter past / to three
  {
    build: (match) => [
      match[1] === 'past'
        ? clock(numberOf(match[2]!), 15, match[3])
        : shifted(clock(numberOf(match[2]!), 0, match[3]), -15),
    ],
    regex: new RegExp(`\\b(?:a )?quarter (past|to) ${NUMBER}${UNIT}${END}`, 'g'),
  },
  // viertel nach / vor drei
  {
    build: (match) => [
      match[1] === 'nach'
        ? clock(numberOf(match[2]!), 15, match[3])
        : shifted(clock(numberOf(match[2]!), 0, match[3]), -15),
    ],
    regex: new RegExp(`\\bviertel (nach|vor) ${NUMBER}${UNIT}${END}`, 'g'),
  },
  // three o'clock
  {
    build: (match) => [clock(numberOf(match[1]!), 0, match[2])],
    regex: new RegExp(`\\b${NUMBER}\\s*o'?clock${UNIT}${END}`, 'g'),
  },
  {
    build: () => [clock(12, 0, 'pm')],
    regex: /\b(?:noon|midday|high noon)\b/g,
  },
  {
    build: () => [clock(0, 0, undefined)],
    regex: /\b(?:midnight|mitternacht)\b/g,
  },
  // from 2 to 4pm, von 14 bis 16 Uhr, between 9 and 11, from 8 to noon — not "from 17 to 18 October"
  {
    build: (match) => {
      const end = clockOf(match[5]!, minutesOf(match[6]), match[7], true);
      return [rangeStart(match[1]!, minutesOf(match[2]), match[3], match[7], end), end];
    },
    regex: new RegExp(
      `\\b(?:from|von|between|zwischen)\\s+${TOKEN}(?::(\\d{2}))?${NOT_A_QUANTITY}${UNIT}\\s*${CLOSER}\\s*${TOKEN}(?::(\\d{2}))?${NOT_A_QUANTITY}${UNIT}`,
      'g',
    ),
  },
  // 2-4pm, 14-16 Uhr, 9-9:30 — a dash range needs a unit or minutes on one side, or it is a date ("17-18 Oct")
  {
    build: (match) => {
      if ([2, 3, 4, 6, 7, 8].every((group) => match[group] === undefined)) {
        return [];
      }
      const end = clock(Number(match[5]), minutesOf(match[6]), match[7], true);
      return [rangeStart(match[1]!, minutesOf(match[2]), match[3], match[7], end), end];
    },
    regex: new RegExp(
      `\\b(\\d{1,2})(?::(\\d{2}))?${UNIT}\\s*[-–]\\s*(\\d{1,2})(?::(\\d{2}))?${UNIT}`,
      'g',
    ),
  },
  // until 5pm, bis 17 Uhr, to 4, until noon — not "bis 17. Oktober"
  {
    build: (match) => [clockOf(match[1]!, minutesOf(match[2]), match[3], true)],
    regex: new RegExp(
      `\\b(?:until|till|bis|to)\\s+${TOKEN}(?::(\\d{2}))?${NOT_A_QUANTITY}${UNIT}${END}`,
      'g',
    ),
  },
];

/** A time written right after a dash or "to" closes a span, whatever pattern read it. */
const CLOSES_BEFORE = /(?:[-–]|\b(?:to|until|till|bis|before|vor))\s*$/;

const scan = (text: string): ReadonlyArray<Found> => {
  const found: Array<Found> = [];
  for (const { build, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const [first, second] = build(match);
      const index = match.index;
      const end = index + match[0].length;
      if (first) {
        found.push({
          ...first,
          closes: first.closes || CLOSES_BEFORE.test(text.slice(0, index)),
          end,
          index,
        });
      }
      if (second) {
        // A range's end follows its start: placed at the range's end, so
        // it neither overlaps the start nor sorts before it.
        found.push({ ...second, end: end + 1, index: end });
      }
      if (match[0].length === 0) {
        regex.lastIndex += 1;
      }
    }
  }
  return found.sort((left, right) => left.index - right.index);
};

/** Of two readings of the same words ("at 7" and "7pm"), the exact one. */
const distinct = (items: ReadonlyArray<Found>): Array<Found> => {
  const kept: Array<Found> = [];
  for (const item of items) {
    const last = kept.at(-1);
    if (last && item.index < last.end) {
      if (item.exact && !last.exact) {
        kept[kept.length - 1] = item;
      }
    } else {
      kept.push(item);
    }
  }
  return kept;
};

const strip = ({ exact, hour, minute }: Found): ClockTime => ({ exact, hour, minute });

/**
 * The clock times the phrase states: the first one as the start, and the
 * first one written as a closer after it ("2 to 4", "9:00-9:30", "until
 * 5pm") as the end. A closer inside the start's own words ("to three" in
 * "quarter to three") is part of the start, not an end. Absent when the
 * phrase names none.
 */
export const statedTimes = (
  phrase: string,
): { readonly end?: ClockTime; readonly start?: ClockTime } => {
  const all = scan(words(phrase));
  const [start] = distinct(all.filter((item) => !item.closes));
  if (!start) {
    return {};
  }
  const end = distinct(
    all.filter((item) => item.closes && (item.index >= start.end || item.end <= start.index)),
  ).find((item) => item.index > start.index);
  return { ...(end ? { end: strip(end) } : {}), start: strip(start) };
};

/** Whether the phrase writes any clock time at all, a bare closer ("until 5pm", "before 10") included. */
export const statesClockTime = (phrase: string): boolean => scan(words(phrase)).length > 0;

const minuteOfDay = (time: string): number => {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return hour * 60 + minute;
};

const format = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/** The 24-hour hours a stated time may mean: one when exact, else both halves of the day. */
const candidates = (time: ClockTime): ReadonlyArray<number> =>
  time.exact ? [time.hour] : time.hour % 12 === 0 ? [12, 0] : [time.hour, time.hour + 12];

/** Minutes from a time to a period's window; 0 inside it. */
const distanceTo = (total: number, { earliestTime, latestTime }: PeriodTimes): number =>
  Math.max(0, minuteOfDay(earliestTime) - total, total - minuteOfDay(latestTime));

/**
 * The model's time is what the phrase stated when its hour is one the
 * stated hour may mean and the minutes agree — "at 1" allows 01:00 and
 * 13:00, "1pm" only 13:00.
 */
export const timeMatches = (time: string, stated: ClockTime): boolean => {
  const [hour = -1, minute = -1] = time.split(':').map(Number);
  return minute === stated.minute && candidates(stated).includes(hour);
};

/**
 * The stated start as a 24-hour time. An open half of the day goes with a
 * period the phrase names ("dinner at 8" is 20:00, "breakfast at 8" is
 * 08:00); without one, 1–6 read as afternoon and 7–11 as morning.
 */
export const resolveStart = (stated: ClockTime, period: Period | undefined): string => {
  const options = candidates(stated).map((hour) => hour * 60 + stated.minute);
  if (options.length === 1) {
    return format(options[0]!);
  }
  if (period) {
    const times = periodTimes(period);
    const nearest = options.reduce((best, option) =>
      distanceTo(option, times) < distanceTo(best, times) ? option : best,
    );
    return format(nearest);
  }
  const hour = stated.hour % 12 === 0 ? 12 : stated.hour <= 6 ? stated.hour + 12 : stated.hour;
  return format(hour * 60 + stated.minute);
};

/** The stated end as the first reading after the start; none when every reading is before it. */
export const resolveEnd = (stated: ClockTime, startTime: string): string | undefined => {
  const startMinutes = minuteOfDay(startTime);
  const after = candidates(stated)
    .map((hour) => hour * 60 + stated.minute)
    .filter((total) => total > startMinutes)
    .sort((left, right) => left - right);
  return after[0] === undefined ? undefined : format(after[0]);
};

export interface GroundedTimes {
  /** Only from a stated range; the model's end is never used alongside a phrase. */
  readonly endTime?: string;
  /**
   * Where the start came from: a stated clock time, a named period's
   * default, the model (the phrase qualifies a period the code cannot
   * place: "after lunch", "not in the morning"), or `none` — the phrase
   * named no time and the event is all day.
   */
  readonly source: 'model' | 'none' | 'period' | 'stated';
  readonly startTime?: string;
}

/**
 * The start the phrase supports. A stated clock time is resolved from the
 * phrase: by the meal or part of the day it names, or else by the model's
 * choice of the half of the day when that choice is one the stated hour
 * allows ("drinks at 9" may be 21:00 if the model says so; "breakfast at
 * 8" is 08:00 whatever it says). Only a meal or part of the day named:
 * its default — unless it is a boundary ("after lunch") or ruled out
 * ("not in the morning"), which the code cannot place, so the model's
 * time stands. Nothing stated: nothing, whatever the model returned.
 */
export const groundTime = (modelStart: string | undefined, phrase: string): GroundedTimes => {
  const { end, start } = statedTimes(phrase);
  const period = periodOf(phrase);
  if (start) {
    const startTime =
      period === undefined && modelStart !== undefined && timeMatches(modelStart, start)
        ? modelStart
        : resolveStart(start, period);
    const endTime = end ? resolveEnd(end, startTime) : undefined;
    return { ...(endTime ? { endTime } : {}), source: 'stated', startTime };
  }
  if (period) {
    if (periodUnreadable(words(phrase))) {
      return { source: 'model', ...(modelStart ? { startTime: modelStart } : {}) };
    }
    return { source: 'period', startTime: periodTimes(period).startTime };
  }
  return { source: 'none' };
};

// --- Days -----------------------------------------------------------------

/**
 * Weekday names and the abbreviations that are nothing else; "sat" and
 * "sun" are words of their own, and German "mi"/"do"/"so" are too.
 */
const WEEKDAYS: ReadonlyArray<{ readonly day: number; readonly names: string }> = [
  { day: 1, names: 'mondays?|mon|montags?' },
  { day: 2, names: 'tuesdays?|tues?|dienstags?' },
  { day: 3, names: 'wednesdays?|wed|mittwochs?' },
  { day: 4, names: 'thursdays?|thu|thur|thurs|donnerstags?' },
  { day: 5, names: 'fridays?|fri|freitags?' },
  { day: 6, names: 'saturdays?|samstags?|sonnabends?' },
  { day: 7, names: 'sundays?|sonntags?' },
];

const DAY_NAMES = WEEKDAYS.map((entry) => entry.names).join('|');

const dayOf = (token: string): number | undefined =>
  WEEKDAYS.find((entry) => new RegExp(`^(?:${entry.names})$`).test(token))?.day;

const weekdaysIn = (text: string): ReadonlyArray<number> =>
  WEEKDAYS.filter((entry) => new RegExp(`\\b(?:${entry.names})\\b`).test(text)).map(
    (entry) => entry.day,
  );

/** The ISO weekdays (1 = Monday … 7 = Sunday) the phrase names, in week order. */
export const namedWeekdays = (phrase: string): ReadonlyArray<number> => weekdaysIn(words(phrase));

const NEXT = /\b(?:next|nachsten?|kommenden?)\b/;
/** A weekday that already happened: not a day to snap forward to. */
const PAST_WEEKDAY = new RegExp(
  `\\b(?:last|past|previous|letzten?|vergangenen?|vorigen?)\\s+(?:${DAY_NAMES})\\b`,
);
/**
 * A day as the anchor of an offset or a boundary ("two weeks from today",
 * "a week from tomorrow", "two days after Monday", "before Friday"): not
 * the date itself, so the model's stands.
 */
const DAY_AS_ANCHOR = new RegExp(
  `\\b(?:from|(?<!day )after|nach)\\s+(?:today|tomorrow|tonight|heute)\\b|\\b(?:after|before|from|nach|vor|ab)\\s+(?:the\\s+|dem\\s+)?(?:${DAY_NAMES})\\b`,
);

/**
 * The day the phrase states, if it states one: "yesterday", "today" and
 * "tomorrow" from the reference date, or a weekday — snapped forward from
 * the model's date when that date is not on it, so "next Friday" never
 * lands on a Thursday; "next <weekday>" said on that weekday is a week
 * on. Undefined when the phrase gives no day the code can read (a month
 * and day, "last Friday", "two weeks from today", "two days after
 * Monday", or German "morgen", which is also "morning"), and the model's
 * date stands.
 */
export const groundDate = (
  modelDate: string | undefined,
  { phrase, referenceDate }: { readonly phrase: string; readonly referenceDate: string },
): string | undefined => {
  const text = words(phrase);
  const today = Temporal.PlainDate.from(referenceDate);
  if (DAY_AS_ANCHOR.test(text) || PAST_WEEKDAY.test(text)) {
    return undefined;
  }
  if (/\b(?:day after tomorrow|ubermorgen)\b/.test(text)) {
    return today.add({ days: 2 }).toString();
  }
  if (/\btomorrow\b/.test(text)) {
    return today.add({ days: 1 }).toString();
  }
  if (/\b(?:yesterday|gestern)\b/.test(text)) {
    return today.subtract({ days: 1 }).toString();
  }
  if (/\b(?:today|heute|tonight)\b/.test(text)) {
    return referenceDate;
  }
  const [day, ...more] = weekdaysIn(text);
  if (day === undefined || more.length > 0) {
    return undefined;
  }
  const anchor =
    modelDate !== undefined && Temporal.PlainDate.compare(modelDate, referenceDate) >= 0
      ? Temporal.PlainDate.from(modelDate)
      : today;
  let candidate = anchor.add({ days: (day - anchor.dayOfWeek + 7) % 7 });
  if (candidate.equals(today) && NEXT.test(text)) {
    candidate = candidate.add({ days: 7 });
  }
  return candidate.toString();
};

// --- Kind -----------------------------------------------------------------

const TODO_CUES =
  /\b(?:remind me|reminder|to-?do|don't forget|dont forget|i (?:need|have) to|i must|ich muss|erinnere mich|erinnerung|nicht vergessen|aufgabe)\b/;

/** A to-do rather than an appointment: the phrase carries one of the cues the prompt names. */
export const isTodoPhrase = (phrase: string): boolean => TODO_CUES.test(words(phrase));

/**
 * A rename ("call it team dinner", "nenn es Teamessen"): the new title is
 * all there is — a meal word, a weekday or a finder cue in the name must
 * not move the event or go looking for a slot.
 */
const RENAME =
  /\b(?:call it|name it|rename|retitle|titled?|nenn(?:e|t)?\s+(?:es|ihn|sie)?|umbenennen|heisst)\b/;

export const isRenamePhrase = (phrase: string): boolean => RENAME.test(words(phrase));

// --- The finder's constraints ---------------------------------------------

/** "Monday through Friday", "Freitag bis Montag": both ends named, every day between. */
const WEEKDAY_RANGE = new RegExp(
  `\\b(${DAY_NAMES})\\s*(?:to|through|thru|until|till|bis|-|–)\\s*(${DAY_NAMES})\\b`,
);

/**
 * The weekdays a finder phrase allows, all of them together: set words
 * ("weekdays", "weekends"), a range, and the days named ("weekdays and
 * Saturdays" is Monday to Saturday); undefined for any day. A phrase that
 * rules days out keeps the model's answer — "any day except Tuesday"
 * names Tuesday without allowing it.
 */
export const groundDays = (
  modelDays: ReadonlyArray<number> | undefined,
  phrase: string,
): ReadonlyArray<number> | undefined => {
  const text = words(phrase);
  if (NEGATION.test(text)) {
    return modelDays;
  }
  const days = new Set<number>();
  if (/\b(?:weekdays|wochentags|werktags|unter der woche)\b/.test(text)) {
    for (const day of [1, 2, 3, 4, 5]) {
      days.add(day);
    }
  }
  if (/\b(?:weekends?|wochenende)\b/.test(text)) {
    days.add(6);
    days.add(7);
  }
  const range = WEEKDAY_RANGE.exec(text);
  const from = range ? dayOf(range[1]!) : undefined;
  const to = range ? dayOf(range[2]!) : undefined;
  let rest = text;
  if (range && from !== undefined && to !== undefined) {
    for (let day = from; ; day = (day % 7) + 1) {
      days.add(day);
      if (day === to) {
        break;
      }
    }
    rest = text.replace(range[0], ' ');
  }
  for (const day of weekdaysIn(rest)) {
    days.add(day);
  }
  return days.size === 0 ? undefined : [...days].sort((left, right) => left - right);
};

/** Number words a length is written in, beyond the clock's one to twelve. */
const LENGTH_WORDS = {
  dreissig: 30,
  eighteen: 18,
  fifteen: 15,
  fifty: 50,
  forty: 40,
  'forty-five': 45,
  fourteen: 14,
  funfundvierzig: 45,
  funfzig: 50,
  hundert: 100,
  hundred: 100,
  neunzig: 90,
  nineteen: 19,
  ninety: 90,
  sechzig: 60,
  seventeen: 17,
  sixteen: 16,
  sixty: 60,
  thirteen: 13,
  thirty: 30,
  twenty: 20,
  vierzig: 40,
  zwanzig: 20,
} as const;
const LENGTH_WORD = Object.keys(LENGTH_WORDS)
  .sort((left, right) => right.length - left.length)
  .join('|');
/** "twenty-five", "twenty five", "fünfundzwanzig": tens and ones as one number. */
const COMPOUND_NUMBER =
  '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](?:one|two|three|four|five|six|seven|eight|nine)|(?:ein|zwei|drei|vier|funf|sechs|sieben|acht|neun)und(?:zwanzig|dreissig|vierzig|funfzig|sechzig)';
const DURATION = new RegExp(
  `\\b(\\d+(?:[.,]\\d+)?|${COMPOUND_NUMBER}|${NUMBER_WORD}|${LENGTH_WORD}|an?|eine?r?)[\\s-]*(${LENGTH_UNITS})\\b|\\b(half an hour|halbe stunde|eineinhalb|anderthalb)\\b`,
);

const TENS = {
  dreissig: 30,
  eighty: 80,
  fifty: 50,
  forty: 40,
  funfzig: 50,
  ninety: 90,
  sechzig: 60,
  seventy: 70,
  sixty: 60,
  thirty: 30,
  twenty: 20,
  vierzig: 40,
  zwanzig: 20,
} as const;

const quantityOf = (token: string): number => {
  const compound = /^([a-z]+)[- ]([a-z]+)$/.exec(token) ?? /^([a-z]+)und([a-z]+)$/.exec(token);
  if (compound) {
    const [, first = '', second = ''] = compound;
    // English says the tens first, German the ones ("fünfundzwanzig").
    const tens = first in TENS ? first : second;
    const ones = tens === first ? second : first;
    return (
      (TENS[tens as keyof typeof TENS] ?? 0) +
      (ones === 'ein' ? 1 : (NUMBER_WORDS[ones as keyof typeof NUMBER_WORDS] ?? 0))
    );
  }
  if (token in LENGTH_WORDS) {
    return LENGTH_WORDS[token as keyof typeof LENGTH_WORDS];
  }
  if (token in NUMBER_WORDS) {
    return NUMBER_WORDS[token as keyof typeof NUMBER_WORDS];
  }
  return /^(?:an?|eine?r?)$/.test(token) ? 1 : Number(token.replace(',', '.'));
};

/**
 * The length the phrase states, in minutes ("90 min", "2h", "two hours",
 * "thirty minutes", "90-minute", "zwei Stunden", "half an hour"), or
 * undefined when it states none.
 */
/** "an hour and a half", "two and a half hours", "zweieinhalb Stunden": a half on top of the hours. */
const HOURS_AND_A_HALF = new RegExp(
  `\\b(?:(an?|one|eine?)\\s+(?:hour|stunde)\\s+and\\s+a\\s+half|(\\d+|${NUMBER_WORD})\\s+and\\s+a\\s+half\\s+(?:hours?|h)|(\\d+|${NUMBER_WORD})\\s+(?:und\\s+eine\\s+halbe|einhalb)\\s+stunden?|(zwei|drei|vier)einhalb\\s+stunden?)\\b`,
);

export const durationMinutesOf = (phrase: string): number | undefined => {
  const text = words(phrase);
  const half = HOURS_AND_A_HALF.exec(text);
  if (half) {
    const hours = half[1] !== undefined ? 1 : quantityOf(half[2] ?? half[3] ?? half[4]!);
    return hours * 60 + 30;
  }
  const every = new RegExp(DURATION.source, 'g');
  let total = 0;
  let end = -1;
  let match: RegExpExecArray | null;
  while ((match = every.exec(text)) !== null) {
    // Parts of one length add up ("1 hour 30 minutes", "1h and 15 min");
    // a second length further on is another matter ("30 min, then 2h").
    if (end !== -1 && !/^(?:\s|and|und|,)*$/.test(text.slice(end, match.index))) {
      break;
    }
    end = match.index + match[0].length;
    if (match[3] !== undefined) {
      total += match[3] === 'half an hour' || match[3] === 'halbe stunde' ? 30 : 90;
      continue;
    }
    const amount = quantityOf(match[1]!);
    const hours = /^(?:h|hr|hrs|hours?|stunden?|std)$/.test(match[2]!);
    total += hours ? amount * 60 : amount;
  }
  const minutes = Math.round(total);
  return end === -1 || !Number.isFinite(minutes) || minutes <= 0 ? undefined : minutes;
};

/** Whether the phrase says how long. */
export const statesDuration = (phrase: string): boolean => durationMinutesOf(phrase) !== undefined;

/** The phrase makes the event last the whole day ("all day", "ganztägig"). */
export const isAllDayPhrase = (phrase: string): boolean =>
  /\b(?:all[- ]day|whole day|ganztag(?:ig|s)?|ganzen tag)\b/.test(words(phrase));

/** The phrase speaks of a repeat ("every Monday", "weekly", "wöchentlich"). */
export const mentionsRepeat = (phrase: string): boolean =>
  /\b(?:every|each|weekly|daily|monthly|yearly|annually|repeat\w*|recurring|jede[nmrs]?|wochentlich|taglich|monatlich|jahrlich|wiederhol\w*)\b/.test(
    words(phrase),
  );

/** The phrase takes a repeat away ("just once", "no repeat", "einmalig"). */
export const clearsRepeat = (phrase: string): boolean =>
  /\b(?:no repeat|not repeat|stop repeating|only once|just once|once only|does ?n[o']t repeat|nicht wiederholen|einmalig|keine wiederholung)\b/.test(
    words(phrase),
  );

/**
 * The phrase names a day the code reads but leaves to the model on
 * purpose: German "morgen" (also "morning"), a day as the anchor of an
 * offset ("two weeks from today", "two days after Monday"), a weekday
 * that has passed ("last Friday"). With one of these, a date the model
 * changed is the answer to the words, not an invention.
 */
export const defersDate = (phrase: string): boolean => {
  const text = words(phrase);
  return /\bmorgen\b/.test(text) || DAY_AS_ANCHOR.test(text) || PAST_WEEKDAY.test(text);
};

/**
 * The phrase names a day in a form the code does not read but the model
 * may ("Oct 20", "17.10.", "in two weeks", "next month"); a bare digit
 * is not one, since a clock time has digits too.
 */
export const mentionsDate = (phrase: string): boolean => {
  const text = words(phrase);
  return (
    new RegExp(`\\b(?:${MONTHS})\\b`).test(text) ||
    /\b\d{1,2}[./]\d{1,2}\b/.test(text) ||
    // An ISO date, and the fixture grammar's day count ("+5").
    /\b\d{4}-\d{2}-\d{2}\b|(?:^|\s)\+\d+\b/.test(text) ||
    /\b(?:next|this|coming|nachste[nrs]?|kommende[nrs]?|diese[nrs]?)\s+(?:week|month|year|woche|monat|jahr)\b/.test(
      text,
    ) ||
    new RegExp(
      `\\bin\\s+(?:an?|\\d+|${NUMBER_WORD})\\s+(?:days?|weeks?|months?|tagen?|wochen?|monaten?)\\b`,
    ).test(text)
  );
};

const WINDOW_WORDS: ReadonlyArray<{
  readonly dates: (
    today: Temporal.PlainDate,
    referenceDate: string,
  ) => { readonly windowEndDate: string; readonly windowStartDate: string };
  readonly words: RegExp;
}> = [
  {
    dates: (today) => sameDay(today.add({ days: 2 })),
    words: /\b(?:day after tomorrow|ubermorgen)\b/,
  },
  { dates: (today) => sameDay(today.add({ days: 1 })), words: /\b(?<!day after )tomorrow\b/ },
  { dates: (today) => sameDay(today), words: /\b(?:today|heute|tonight)\b/ },
  {
    dates: (_, referenceDate) => finderWindowDates('fortnight', referenceDate),
    // A span of two weeks — "in two weeks" is an offset the model resolves.
    words:
      /\b(?:(?:next|coming|within|over the next|in the next|for the next|nachsten|kommenden) (?:two|2|zwei) (?:weeks?|wochen)|fortnight)\b/,
  },
  {
    dates: (_, referenceDate) => finderWindowDates('nextWeek', referenceDate),
    words: /\b(?:next week|nachste woche|kommende woche)\b/,
  },
  {
    dates: (_, referenceDate) => finderWindowDates('week', referenceDate),
    words: /\b(?:this week|diese woche)\b/,
  },
];

function sameDay(date: Temporal.PlainDate): {
  readonly windowEndDate: string;
  readonly windowStartDate: string;
} {
  const day = date.toString();
  return { windowEndDate: day, windowStartDate: day };
}

const WINDOW_TERMS =
  'tomorrow|today|tonight|heute|next week|this week|nachste woche|diese woche|kommende woche';
/**
 * A window word as one end of a span or the anchor of an offset
 * ("starting tomorrow", "between tomorrow and August 28", "before next
 * week", "a week from today"): not the window.
 */
const WINDOW_AS_END = new RegExp(
  `\\b(?:starting|from|beginning|ab|until|till|bis|to|between|zwischen|von|(?<!day )after|nach|before|vor)\\s+(?:${WINDOW_TERMS})\\b|\\b(?:${WINDOW_TERMS})\\s+(?:and|to|until|till|through|bis|und|-|–)\\s`,
);

/**
 * The date window a finder phrase names in words the code can read: one
 * day, this or next week, a span of two weeks. Undefined when it names
 * none, more than one ("between today and tomorrow"), one as the end of
 * a span ("before next week"), or a date the model has to resolve.
 */
export const windowOf = (
  phrase: string,
  referenceDate: string,
): { readonly windowEndDate: string; readonly windowStartDate: string } | undefined => {
  const text = words(phrase);
  const named = WINDOW_WORDS.filter((entry) => entry.words.test(text));
  if (named.length !== 1 || WINDOW_AS_END.test(text)) {
    return undefined;
  }
  return named[0]!.dates(Temporal.PlainDate.from(referenceDate), referenceDate);
};

/**
 * The finder's daily bounds the phrase supports: the model's where a
 * clock time is written ("after 5pm", "until 5pm", "before 10") or a
 * meal is a boundary or ruled out ("before lunch", "not in the
 * morning"), the period's window where only a meal or part of the day is
 * named, none otherwise (the solver's daytime default).
 */
export const groundBounds = (
  bounds: { readonly earliestTime?: string | undefined; readonly latestTime?: string | undefined },
  phrase: string,
): { readonly earliestTime?: string; readonly latestTime?: string } => {
  const text = words(phrase);
  if (statesClockTime(phrase) || periodUnreadable(text)) {
    return {
      ...(bounds.earliestTime ? { earliestTime: bounds.earliestTime } : {}),
      ...(bounds.latestTime ? { latestTime: bounds.latestTime } : {}),
    };
  }
  const period = periodOf(phrase);
  if (period) {
    const { earliestTime, latestTime } = periodTimes(period);
    return { earliestTime, latestTime };
  }
  return {};
};

// --- Title ----------------------------------------------------------------

/** A part of the day after a day ("tomorrow morning", "Montag Abend"). */
const DAY_PART = String.raw`(?:\s+(?:morning|afternoon|evening|night|fruh|vormittag|mittag|nachmittag|abend|nacht))?`;

/** A day said in words, at the start or end of a title. */
const DAY_WORDS = String.raw`(?:the\s+)?day after tomorrow|tomorrow|today|tonight|heute|morgen|ubermorgen`;

/**
 * The words that say when, as one run that ends a title: a day, a weekday
 * ("on Friday", "next Tuesday", "am Montag"), a part of the day after
 * "this" or "in the", a repeat ("every Monday", "weekly", "jeden Tag"), a
 * month date ("Sep 1", "1st of May", "17.10."), all day. Clock times are
 * read by `scan`, as for the start.
 */
const WHEN_AT_END = new RegExp(
  String.raw`(?:^|\s)[(\["']?(?:` +
    [
      `(?:${DAY_WORDS})${DAY_PART}`,
      `(?:(?:on|this|next|coming|am|nachsten|nachste|kommenden|kommende|diesen|diese)\\s+)?(?:${DAY_NAMES})${DAY_PART}`,
      String.raw`(?:this|in the)\s+(?:morning|afternoon|evening)|at night|morgens|vormittags|mittags|nachmittags|abends|nachts`,
      `(?:every|each|jede[nmrs]?|alle)\\s+(?:(?:other|second|\\d+|${NUMBER_WORD}|zweiten?)\\s+)?(?:days?|weeks?|months?|years?|weekdays?|weekends?|tage?|wochen?|monate?|jahre?|werktage?|${DAY_NAMES})`,
      String.raw`weekly|daily|monthly|yearly|annually|wochentlich|taglich|monatlich|jahrlich`,
      `(?:(?:on|am)\\s+)?(?:(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?(?:${MONTHS})\\.?|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}\\.\\d{1,2}\\.(?:\\d{2,4})?)(?:,?\\s+\\d{4})?`,
      String.raw`all[- ]day|whole day|ganztag(?:ig|s)?|(?:den\s+)?ganzen tag`,
    ].join('|') +
    String.raw`)[)\]"'.,;:!?–-]*$`,
);

/** A day said first ("Tomorrow: lunch with Tom"); a weekday first names the event ("Monday standup"). */
const DAY_AT_START = new RegExp(String.raw`^[(\["']?(?:${DAY_WORDS})[)\]"'.,;:!?–-]*(?=\s)`);

/** A word left hanging once the when after it is gone ("Lunch at", "Treffen um", "Dinner for"). */
const HANGING =
  /^(?:on|at|um|am|by|for|fur|from|von|ab|gegen|this|next|nachsten|kommenden|[,;:@–-])$/;

/** Where the run of when-words that ends `text` starts, at a word; undefined for none. */
const whenAtEnd = (text: string): number | undefined => {
  const tail = text.replace(/[\s.,;:!?)\]"'–-]+$/, '').length;
  const starts = scan(text)
    .filter(
      ({ end, index }) => index < tail && end >= tail && (index === 0 || text[index - 1] === ' '),
    )
    .map(({ index }) => index);
  const match = WHEN_AT_END.exec(text);
  if (match) {
    starts.push(match[0].startsWith(' ') ? match.index + 1 : match.index);
  }
  return starts.length === 0 ? undefined : Math.min(...starts);
};

/**
 * The title's words without the when at its ends: the first and the
 * past-the-last word kept, and whether nothing but when is left.
 */
const whenless = (
  title: string,
): { readonly first: number; readonly last: number; readonly onlyWhen: boolean } => {
  // Folded word by word and joined by one space, so a place in the text
  // is a count of words in the title.
  const folded = [...title.matchAll(/\S+/g)].map(([token]) => words(token));
  let last = folded.length;
  for (;;) {
    const text = folded.slice(0, last).join(' ');
    const start = whenAtEnd(text);
    if (start === 0) {
      return { first: 0, last, onlyWhen: true };
    }
    if (start === undefined) {
      break;
    }
    last = text.slice(0, start).trimEnd().split(' ').length;
    while (last > 1 && HANGING.test(folded[last - 1]!)) {
      last -= 1;
    }
  }
  const leading = DAY_AT_START.exec(folded.slice(0, last).join(' '));
  const first = leading ? leading[0].split(' ').length : 0;
  return first < last ? { first, last, onlyWhen: false } : { first: 0, last, onlyWhen: true };
};

/**
 * The title without the words about when at its ends: "lunch with tom
 * tomorrow" is "lunch with tom", "Team standup every Monday at 9" is
 * "Team standup", "Zahnarzt Dienstag um 10" is "Zahnarzt", "Tomorrow:
 * lunch with Tom" is "lunch with Tom". The day, the time and the repeat
 * are read from the phrase itself, and the model leaves their words in
 * the title as often as not. Only the ends: a weekday that opens a title
 * names the event ("Monday standup"), words in the middle stay, and a
 * bare number is no time ("Room 9"). A title that is nothing but when
 * stays as it is.
 */
export const trimWhen = (title: string): string => {
  const tokens = [...title.matchAll(/\S+/g)];
  const { first, last, onlyWhen } = whenless(title);
  if (onlyWhen || (first === 0 && last === tokens.length)) {
    return title;
  }
  const end = tokens[last - 1]!;
  return title.slice(tokens[first]!.index, end.index + end[0].length).replace(/[\s,;:–—-]+$/u, '');
};

/** The words of a text, folded: its runs of letters and digits ("Tom's" is "tom" and "s"). */
const wordsOf = (text: string): ReadonlyArray<string> => words(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The title the phrase supports: the model's, when every word of it is
 * one the phrase says and it names more than a when — else the phrase
 * itself. The model copies titles it has seen ("Lunch with Sarah" for
 * "lunch with tom tomorrow", the prompt's old example) and keeps a when
 * alone ("tomorrow" for "dinner with tom tomorrow"); the user's own words
 * are never wrong about who and what.
 */
export const groundTitle = (title: string, phrase: string): string => {
  const said = new Set(wordsOf(phrase));
  const fromPhrase = wordsOf(title).every((word) => said.has(word));
  return fromPhrase && !whenless(title).onlyWhen ? title : phrase.trim();
};
