import {
  type ByDay,
  finderWindowDates,
  foldSearchText,
  type MonthlyOrdinal,
  type RecurrenceFrequency,
  Temporal,
  WEEKDAYS_MONDAY_FIRST,
} from '@calendar/core';

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
/** A part of the day a German weekday may carry as one word ("Montagabend", "sonntagmorgens"). */
const GERMAN_DAY_PARTS = 'morgen|vormittag|mittag|nachmittag|abend|nacht';
const german = (day: string): string => `${day}(?:s|(?:${GERMAN_DAY_PARTS})s?)?`;
const WEEKDAYS: ReadonlyArray<{ readonly day: number; readonly names: string }> = [
  { day: 1, names: `mondays?|mon|${german('montag')}` },
  { day: 2, names: `tuesdays?|tues?|${german('dienstag')}` },
  { day: 3, names: `wednesdays?|wed|${german('mittwoch')}` },
  { day: 4, names: `thursdays?|thu|thur|thurs|${german('donnerstag')}` },
  { day: 5, names: `fridays?|fri|${german('freitag')}` },
  { day: 6, names: `saturdays?|${german('samstag')}|sonnabends?` },
  { day: 7, names: `sundays?|${german('sonntag')}` },
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
 * The weekdays a finder phrase (or a repeat) allows, all of them together:
 * set words ("weekdays", "every weekday", "weekends"), a range, and the
 * days named ("weekdays and Saturdays" is Monday to Saturday); undefined
 * for any day. A phrase that rules days out keeps the model's answer —
 * "any day except Tuesday" names Tuesday without allowing it.
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
  if (/\b(?:weekdays?|wochentags|werktags?|werktagen?|unter der woche)\b/.test(text)) {
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
  return /^(?:an?|eine?[nrs]?)$/.test(token) ? 1 : Number(token.replace(',', '.'));
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

// --- Repeats --------------------------------------------------------------

/** Plural weekdays are a habit ("Mondays at 9", "montags", "freitagabends"): a repeat without "every". */
const HABITUAL_WEEKDAYS = `mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)(?:${GERMAN_DAY_PARTS})?s`;
const HABIT = new RegExp(`\\b(?:${HABITUAL_WEEKDAYS})\\b`);

/** The units a repeat counts in, and the frequency each stands for ("every morning" is daily). */
const REPEAT_UNITS: ReadonlyArray<{ readonly freq: RecurrenceFrequency; readonly names: string }> =
  [
    {
      freq: 'daily',
      names: `days?|tage?n?|mornings?|afternoons?|evenings?|nights?|${GERMAN_DAY_PARTS}`,
    },
    { freq: 'weekly', names: 'weeks?|wochen?' },
    { freq: 'monthly', names: 'months?|monat(?:e|en|s)?' },
    { freq: 'yearly', names: 'years?|jahre?n?' },
  ];
const REPEAT_UNIT = REPEAT_UNITS.map((unit) => unit.names).join('|');
const freqOfUnit = (token: string): RecurrenceFrequency | undefined =>
  REPEAT_UNITS.find((unit) => new RegExp(`^(?:${unit.names})$`).test(token))?.freq;

/** One and up, as a count, a gap or a span can be. */
const wholeNumber = (value: number | undefined): value is number =>
  value !== undefined && Number.isInteger(value) && value >= 1;

const EVERY = 'every|each|jede[nmrs]?';
/** The gap between two of them ("every other week", "alle zwei Wochen", "every third day"). */
const GAP_WORDS: Readonly<Record<string, number>> = {
  '2nd': 2,
  '3rd': 3,
  '4th': 4,
  '5th': 5,
  andere: 2,
  'couple of': 2,
  dritte: 3,
  einzelne: 1,
  fifth: 5,
  fourth: 4,
  funfte: 5,
  other: 2,
  second: 2,
  single: 1,
  third: 3,
  vierte: 4,
  zweite: 2,
};
const GAP = `other|second|2nd|third|3rd|fourth|4th|fifth|5th|single|couple of|andere[nmrs]?|zweite[nmrs]?|dritte[nmrs]?|vierte[nmrs]?|funfte[nmrs]?|einzelne[nmrs]?|\\d+|${NUMBER_WORD}`;
/** A German ending taken off ("zweiten" is "zweite"); an English word is looked up as it is ("other"). */
const stem = (token: string): string => token.replace(/(?<=e)[nmrs]$/, '');
const gapOf = (token: string): number | undefined => {
  const gap = GAP_WORDS[token] ?? GAP_WORDS[stem(token)] ?? quantityOf(token);
  return wholeNumber(gap) ? gap : undefined;
};
/**
 * The lead word, a gap and a unit. German "alle" needs the gap: alone it
 * is "everyone" ("Rundmail an alle morgen").
 */
const EVERY_UNIT = new RegExp(
  `\\b(?:(?:${EVERY})\\s+(?:(${GAP})\\s+)?|alle\\s+(${GAP})\\s+)(${REPEAT_UNIT})\\b`,
);

const DAY_SET = 'weekdays?|weekends?|werktags?|werktage?n?|wochentags|wochenende[ns]?';
const IS_DAY_SET = new RegExp(`^(?:${DAY_SET})$`);
/** A position in the month: "first", "4th", "ersten", "1." (German); "last" apart, since "last Friday" alone is a day gone by. */
const FIRST_TO_FOURTH = String.raw`first|1st|second|2nd|third|3rd|fourth|4th|[1-4]\.|erste[nrs]?|zweite[nrs]?|dritte[nrs]?|vierte[nrs]?`;
const ORDINAL = `${FIRST_TO_FOURTH}|last|letzte[nrs]?`;
/**
 * "every Monday", "jeden ersten Freitag", "every other weekend", "every
 * weekday": the lead word, a gap or position, and a day or day set.
 */
const EVERY_DAY = new RegExp(
  `\\b(?:${EVERY})\\s+(?:(${GAP}|${ORDINAL})\\s+)?(${DAY_NAMES}|${DAY_SET})\\b`,
);

/**
 * A frequency word as an adjective names no repeat ("the weekly report",
 * "my monthly budget"): the model decides, as for any other noun.
 */
const ADJECTIVE_LEAD = String.raw`(?<!\b(?:the|my|our|your|a|an|this|that|der|die|das|den|dem|des|ein|eine|einen|einem|einer|unsere?n?|meine?n?)\s)`;
/** Frequency words that stand alone; "fortnightly" and "alle 14 Tage" are every two weeks, "alle acht Tage" every week. */
const FREQUENCY_WORDS: ReadonlyArray<{
  readonly freq: RecurrenceFrequency;
  readonly interval?: number;
  readonly words: string;
}> = [
  {
    freq: 'weekly',
    interval: 2,
    words: 'bi-?weekly|fortnightly|zweiwochentlich|vierzehntagig|alle (?:14|vierzehn) tage',
  },
  { freq: 'weekly', words: 'alle (?:8|acht) tage' },
  { freq: 'monthly', interval: 3, words: 'quarterly|every quarter|vierteljahrlich|quartalsweise' },
  { freq: 'daily', words: 'daily|taglich|once a day|einmal (?:pro|am) tag' },
  { freq: 'weekly', words: 'weekly|wochentlich|once a week|einmal (?:pro|die|in der) woche' },
  { freq: 'monthly', words: 'monthly|monatlich|once a month|einmal (?:pro|im) monat' },
  { freq: 'yearly', words: 'yearly|annually|jahrlich|once a year|einmal (?:pro|im) jahr' },
];
const FREQUENCY_PATTERNS = FREQUENCY_WORDS.map((entry) => ({
  ...entry,
  pattern: new RegExp(`${ADJECTIVE_LEAD}\\b(?:${entry.words})\\b`),
}));

/**
 * The month as the frame of a day: "the 1st of the month", "every 15th",
 * "jeden 15.", "ersten Freitag im Monat", "15. des Monats" are monthly.
 * "End of the month" and "employee of the month" are not.
 */
const MONTH_FRAME = new RegExp(
  `\\b(?:(?:\\d{1,2}(?:st|nd|rd|th|\\.)|(?:${ORDINAL})\\s+(?:${DAY_NAMES}))\\s+(?:of (?:the|every|each) month|des monats|im monat|jeden monats)\\b|(?:${EVERY})\\s+\\d{1,2}(?:st|nd|rd|th|\\.)(?!\\d)(?!\\s*(?:${MONTHS}|${REPEAT_UNIT}|${DAY_NAMES}|${DAY_SET}|min|minutes?|uhr|h)\\b))`,
);
const NAMES_MONTH = /\b(?:month|monthly|monats?|monatlich)\b/;

/**
 * "every other Tuesday", "the first Monday", "jeden letzten Freitag",
 * "first Friday of the month": a position before a weekday. "other" is
 * every second week; "second" is too, unless the month is named ("the
 * second Tuesday of the month"). "last" and "other" need a lead word.
 */
const ORDINAL_WEEKDAY = new RegExp(
  `\\b(?:(?:${EVERY}|the|den|am)\\s+(other|andere[nrs]?|${ORDINAL})|(${FIRST_TO_FOURTH}))\\s+(${DAY_NAMES})\\b`,
);
const ORDINALS: Readonly<Record<string, MonthlyOrdinal>> = {
  '1.': 1,
  '1st': 1,
  '2.': 2,
  '2nd': 2,
  '3.': 3,
  '3rd': 3,
  '4.': 4,
  '4th': 4,
  dritte: 3,
  erste: 1,
  first: 1,
  fourth: 4,
  last: -1,
  letzte: -1,
  second: 2,
  third: 3,
  vierte: 4,
  zweite: 2,
};
const ordinalOf = (token: string): MonthlyOrdinal | undefined =>
  ORDINALS[token] ?? ORDINALS[stem(token)];

/** "10 times", "zehnmal", "3x" — not "3 times a week" or "3x weekly", which is no count. */
const COUNT = new RegExp(
  `\\b(\\d+|${COMPOUND_NUMBER}|${NUMBER_WORD}|${LENGTH_WORD})[\\s-]*(?:times|x|mal)\\b(?!\\s+(?:(?:a|per|pro|die|im|in der)\\s+(?:day|week|month|year|tag|woche|monat|jahr)|weekly|daily|monthly|yearly|wochentlich|taglich|monatlich|jahrlich|every|each|jede[nmrs]?)\\b)`,
);

export type RepeatSpanUnit = 'days' | 'months' | 'weeks' | 'years';
const SPAN_UNITS: ReadonlyArray<{ readonly names: string; readonly unit: RepeatSpanUnit }> = [
  { names: 'days?|tage?n?', unit: 'days' },
  { names: 'weeks?|wochen?', unit: 'weeks' },
  { names: 'months?|monate?n?', unit: 'months' },
  { names: 'years?|jahre?n?', unit: 'years' },
];
const SPAN_UNIT = SPAN_UNITS.map((unit) => unit.names).join('|');
const spanUnitOf = (token: string): RepeatSpanUnit =>
  SPAN_UNITS.find((unit) => new RegExp(`^(?:${unit.names})$`).test(token))!.unit;
/** The unit a frequency counts in. */
const UNIT_OF_FREQUENCY: Readonly<Record<RecurrenceFrequency, RepeatSpanUnit>> = {
  daily: 'days',
  monthly: 'months',
  weekly: 'weeks',
  yearly: 'years',
};
/**
 * Whether a span is at least as long as the rule's period: "for six weeks"
 * ends a weekly rule, "for a week" on a yearly one is the event's length.
 */
export const spanUnitAtLeast = (unit: RepeatSpanUnit, freq: RecurrenceFrequency): boolean =>
  SPAN_UNITS.findIndex((entry) => entry.unit === unit) >=
  SPAN_UNITS.findIndex((entry) => entry.unit === UNIT_OF_FREQUENCY[freq]);
/**
 * Whether a repeat's span is the rule's end: long enough for its period
 * (`spanUnitAtLeast`), or days on a weekly rule with several days ("every
 * weekday for three days").
 */
export const spanEndsRepeat = (repeat: StatedRepeat): boolean =>
  repeat.runsFor !== undefined &&
  repeat.freq !== undefined &&
  (spanUnitAtLeast(repeat.runsFor.unit, repeat.freq) ||
    (repeat.freq === 'weekly' && (repeat.byDay?.length ?? 0) > 1));
/** "for six weeks", "for the next two months", "zwei Wochen lang": how long the repeat runs. */
const RUNS_FOR = new RegExp(
  `\\b(?:for|fur)\\s+(?:the\\s+)?(?:(?:next|coming|nachsten|kommenden)\\s+)?(\\d+|${NUMBER_WORD}|${LENGTH_WORD}|an?|one|eine?[nrs]?)\\s+(${SPAN_UNIT})\\b|\\b(\\d+|${NUMBER_WORD}|${LENGTH_WORD}|eine?[nrs]?)\\s+(${SPAN_UNIT})\\s+lang\\b`,
);

/**
 * The phrase speaks of a repeat: "every Monday", "every two weeks",
 * "weekly", "wöchentlich", "Mondays", "alle zwei Wochen", "once a month",
 * "fortnightly", "make it repeat". A bare "every", "each" or "jeder"
 * is not one ("each candidate", "jeder bringt was mit"), nor is a
 * repeat as a noun ("Repeat blood test", "Mathe Wiederholung") or a
 * frequency as an adjective ("the weekly report").
 */
const REPEAT_CUE = new RegExp(
  `${ADJECTIVE_LEAD}\\b(?:${FREQUENCY_WORDS.map((entry) => entry.words).join('|')})\\b|\\b(?:repeats|repeating|recurring|make it repeat|repeat (?:it|this|that)|wiederholend|wiederkehrend|sich wiederhol\\w*|wiederholt sich|${HABITUAL_WEEKDAYS}|weekdays|werktags|werktagen|wochentags|weekends)\\b|${MONTH_FRAME.source}|${EVERY_UNIT.source}|${EVERY_DAY.source}`,
);

/** The phrase takes a repeat away ("just once", "no repeat", "einmalig") — "just once a week" does not. */
export const clearsRepeat = (phrase: string): boolean =>
  /\b(?:no repeat|not repeat|stop repeating|(?:only once|just once|once only)(?!\s+(?:a|per|every|each|pro|die|im|in der)\b)|does ?n[o']t repeat|nicht wiederholen|einmalig|keine wiederholung)\b/.test(
    words(phrase),
  );

/** The words that may stand between an until word and its day ("bis zum", "until the"). */
const UNTIL_LEADS = String.raw`(?:(?:zum|zur|the|einschliesslich|inklusive|incl\.?)\s+)*`;
const HOLIDAYS =
  'christmas|xmas|easter|new year|weihnachten|ostern|silvester|neujahr|the holidays|summer|autumn|fall|winter|spring|sommer|herbst|fruhling|fruhjahr';
/**
 * A day written in numbers: "15 March", "15. März", "the 15th", "15.",
 * "31.12.", "12/31", "2026-12-31", "2027" — never "9.30" or "18.30."
 * (clock times: a month is 1 to 12).
 */
const DAY_IN_NUMBERS = `\\d{1,2}(?:st|nd|rd|th)?\\.?\\s*(?:of\\s+)?(?:${MONTHS})\\b|\\d{1,2}(?:st|nd|rd|th)\\b|\\d{1,2}\\.(?:0?[1-9]|1[0-2])\\.(?:\\d{2,4})?(?![\\d:])|\\d{1,2}\\.(?![\\d:])|\\d{1,2}/\\d{1,2}\\b|\\d{4}(?:-\\d{2}-\\d{2})?\\b`;
/**
 * What an end may name: a month, a weekday, a day in numbers, a relative
 * day, "the end" of something, a holiday or a season — not a clock time
 * ("until 5pm", "ends at 9", "bis halb neun") and not words ("until
 * further notice", "bis Mittag", "bis zu 12 Teilnehmer").
 */
const END_DAY = `(?:${MONTHS})\\b|(?:(?:next|this|coming|nachste[nrs]?|diese[nrs]?|kommende[nrs]?)\\s+)?(?:${DAY_NAMES}|week|month|year|woche|monat|jahr)\\b|end\\b|ende\\b|tomorrow\\b|ubermorgen\\b|(?:${HOLIDAYS})\\b|${DAY_IN_NUMBERS}`;
/**
 * An end the phrase leads into ("until March", "bis zum 15. März",
 * "ending Oct 20", "through Friday"), as opposed to a clock time or a
 * span of weekdays ("Monday through Friday"); "go through emails" is
 * no end.
 */
const UNTIL = new RegExp(
  `\\b(?:until|till|til|up to|ending|ends|bis)\\s+${UNTIL_LEADS}(?=${END_DAY})|\\b(?:through|thru)\\s+(?:the\\s+)?(?=${END_DAY})`,
);

export const statesUntil = (phrase: string): boolean => {
  const text = words(phrase);
  return END_WEEKDAY_AFTER_EVERY.test(text) || UNTIL.test(text.replace(WEEKDAY_RANGE, ' '));
};

/** The phrase says the repeat has no end ("forever", "indefinitely", "ohne Ende"). */
export const statesNoEnd = (phrase: string): boolean =>
  /\b(?:forever|indefinitely|with no end|without (?:an )?end|no end date|open[- ]ended|fur immer|ohne ende|unbegrenzt|endlos|bis auf weiteres)\b/.test(
    words(phrase),
  );

/** Days ruled out ("except holidays", "but not in August") are not the rule's: the words from the negation on are left out. */
const NEGATED_TAIL = new RegExp(`${NEGATION.source}.*$`);
/** A weekday the rule starts on, not one it falls on ("Tuesdays and Thursdays starting Monday"); "from Monday to Friday" is a range. */
const START_DAY = new RegExp(
  `\\b(?:starting|beginning|from|ab|seit)\\s+(?:(?:the|next|this|dem|den|nachste[nmrs]?|diese[nmrs]?)\\s+)?(?:${DAY_NAMES})\\b(?!\\s*(?:to|through|thru|until|till|bis|-|–)\\b)`,
);
const DAY_LEADS = String.raw`(?:(?:zum|zur|the|dem|den|next|this|nachste[nmrs]?|diese[nmrs]?)\s+)*`;
/**
 * A weekday the rule ends on, not one it falls on ("Piano every Tuesday
 * at 5pm until Friday"); "Monday through Friday" and "Montag bis
 * Freitag" are ranges — unless "every" stands right before the first
 * day ("every Tuesday until Friday" ends on Friday).
 */
const END_WEEKDAY_AFTER_EVERY = new RegExp(
  `(\\b(?:${EVERY})\\s+(?:${DAY_NAMES}))\\s+(?:until|till|til|bis)\\s+${DAY_LEADS}(?:${DAY_NAMES})\\b`,
);
const END_WEEKDAY = new RegExp(
  `(?<!\\b(?:${DAY_NAMES})\\s+)\\b(?:until|till|til|through|thru|up to|ending|ends|bis)\\s+${DAY_LEADS}(?:${DAY_NAMES})\\b`,
);
/** The words the rule's days are read from. */
const dayWords = (text: string): string =>
  text
    .replace(NEGATED_TAIL, '')
    .replace(END_WEEKDAY_AFTER_EVERY, '$1 ')
    .replace(END_WEEKDAY, ' ')
    .replace(START_DAY, ' ');

/** Whether the phrase names a day or a day set for the rule, even one it does not list (a single weekday is the date's). */
export const namesDays = (phrase: string): boolean =>
  (groundDays(undefined, dayWords(words(phrase))) ?? []).length > 0;

/** A day set named in passing ("weekends included") leaves a daily rule daily. */
const IN_PASSING = /\b(?:includ(?:ed|ing)|incl|inklusive|einschliesslich|eingeschlossen|auch)\b/;

/** The last place a pattern matches ("change from every week to every month" means monthly). */
const lastMatch = (pattern: RegExp, text: string): RegExpExecArray | null => {
  const every = new RegExp(pattern.source, 'g');
  let last: RegExpExecArray | null = null;
  for (let match = every.exec(text); match !== null; match = every.exec(text)) {
    last = match;
  }
  return last;
};

/** The repeat as the phrase states it; what it leaves unsaid is undefined. */
export interface StatedRepeat {
  /**
   * A day set or several days ("every weekday", "Mondays and Wednesdays"):
   * a weekly rule's days. One weekday under a monthly rule ("every month
   * on Wednesday", "the first Monday"), with its ordinal when said. One
   * weekday under a weekly rule is the date's, not listed here.
   */
  readonly byDay?: ReadonlyArray<ByDay> | undefined;
  /** "10 times", "zehnmal". */
  readonly count?: number | undefined;
  readonly freq?: RecurrenceFrequency | undefined;
  /** Two and up: "every other week" is 2. */
  readonly interval?: number | undefined;
  /** "for six weeks": how long it runs, in the words' own unit. */
  readonly runsFor?: { readonly amount: number; readonly unit: RepeatSpanUnit } | undefined;
}

/**
 * What the phrase says about repeating, read for itself: the frequency
 * and gap ("every two weeks", "monthly", "jeden Tag"), the days ("every
 * weekday", "Tuesdays and Thursdays"), a count ("10 times") and a span
 * ("for six weeks"). Undefined when the phrase names no repeat — unless
 * it is said of something that repeats (`ofRepeat`), where a count or a
 * span alone is a reading. A repeat named in words the code does not
 * read ("make it recurring") is an empty reading, where the model's
 * frequency stands.
 */
export const statedRepeat = (
  phrase: string,
  { ofRepeat = false }: { readonly ofRepeat?: boolean } = {},
): StatedRepeat | undefined => {
  const text = words(phrase);
  const times = COUNT.exec(text);
  const count = times === null ? undefined : quantityOf(times[1]!);
  const span = RUNS_FOR.exec(text);
  const amount = span === null ? undefined : quantityOf(span[1] ?? span[3]!);
  const tail = {
    ...(wholeNumber(count) ? { count } : {}),
    ...(span !== null && wholeNumber(amount)
      ? { runsFor: { amount, unit: spanUnitOf(span[2] ?? span[4]!) } }
      : {}),
  };
  if (!REPEAT_CUE.test(text)) {
    return ofRepeat && Object.keys(tail).length > 0 ? tail : undefined;
  }
  let freq: RecurrenceFrequency | undefined;
  let interval: number | undefined;
  let byDay: ReadonlyArray<ByDay> | undefined;
  // The last frequency word is the one meant ("change from weekly to
  // monthly"); one ruled out is not ("monthly, not weekly").
  const scope = text.replace(NEGATED_TAIL, '');
  const word = FREQUENCY_PATTERNS.map((entry) => ({ at: entry.pattern.exec(scope)?.index, entry }))
    .filter(
      (found): found is { at: number; entry: (typeof FREQUENCY_PATTERNS)[number] } =>
        found.at !== undefined,
    )
    .sort((left, right) => right.at - left.at)[0]?.entry;
  const every = lastMatch(EVERY_UNIT, scope);
  const everyFreq = every === null ? undefined : freqOfUnit(every[3]!);
  const everyGap = every === null ? undefined : gapOf(every[1] ?? every[2] ?? '');
  if (word) {
    // "Weekly 1:1 every other week": the word names the kind, the gap stands.
    freq = word.freq;
    interval = word.interval ?? (everyFreq === word.freq ? everyGap : undefined);
  } else if (every) {
    freq = everyFreq;
    interval = everyGap;
  } else if (MONTH_FRAME.test(text)) {
    freq = 'monthly';
  }
  // "every Monday", "every weekday", "Mondays": weekly, unless a kind was
  // named; "every other weekend" with its gap. A position before one
  // weekday ("every first Friday") is read below.
  const everyDay = EVERY_DAY.exec(text);
  if (everyDay && (everyDay[1] === undefined || IS_DAY_SET.test(everyDay[2]!))) {
    freq ??= 'weekly';
    if (everyDay[1] !== undefined) {
      interval ??= gapOf(everyDay[1]);
    }
  } else if (everyDay === null && HABIT.test(text)) {
    freq ??= 'weekly';
  }
  // A position before a weekday: "the first Monday of every month" is
  // monthly on that Monday, "every other Tuesday" weekly with a gap of
  // two. A kind the words name otherwise ("weekly", "every year",
  // "every Monday … starting the first Monday") stands.
  const ordinal = ORDINAL_WEEKDAY.exec(text);
  if (ordinal) {
    const token = ordinal[1] ?? ordinal[2]!;
    const position = ordinalOf(token);
    const weekday = WEEKDAYS_MONDAY_FIRST[dayOf(ordinal[3]!)! - 1]!;
    if (position === undefined || (position === 2 && !NAMES_MONTH.test(text))) {
      if (freq === undefined || freq === 'weekly') {
        freq = 'weekly';
        interval ??= 2;
      }
    } else if (freq === undefined || freq === 'monthly') {
      freq = 'monthly';
      byDay = [{ ordinal: position, weekday }];
    }
  }
  if (byDay === undefined) {
    const days = groundDays(undefined, dayWords(text)) ?? [];
    const codes = days.map((day) => WEEKDAYS_MONDAY_FIRST[day - 1]!);
    if (freq === 'monthly') {
      byDay = codes.length === 1 ? [{ weekday: codes[0]! }] : undefined;
    } else if (
      codes.length > 1 &&
      (freq === undefined || freq === 'weekly' || (freq === 'daily' && !IN_PASSING.test(text)))
    ) {
      // Several days are a weekly rule's, "every day, Monday through
      // Friday" included; a gap in days does not carry over to weeks.
      if (freq === 'daily') {
        interval = undefined;
      }
      freq = 'weekly';
      byDay = codes.map((weekday) => ({ weekday }));
    }
  }
  return {
    ...(byDay === undefined ? {} : { byDay }),
    ...(freq === undefined ? {} : { freq }),
    ...(interval === undefined || interval < 2 ? {} : { interval }),
    ...tail,
  };
};

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
/**
 * The phrase names a fixed day in a form the code does not resolve: a
 * month ("Oct 20", "17. Oktober"), a dotted or slashed date ("17.10.",
 * "12/31"), an ISO date, an offset from today ("in two days", "in drei
 * Wochen") — not "next week", and not a clock ("9.30").
 */
export const mentionsFixedDate = (phrase: string): boolean => {
  const text = words(phrase);
  return (
    new RegExp(
      `\\bin\\s+(?:\\d+|${NUMBER_WORD}|an?|eine[rm]?|ein)\\s+(?:days?|weeks?|months?|years?|tagen?|wochen?|monaten?|jahren?)\\b`,
    ).test(text) ||
    new RegExp(`\\b(?:${MONTHS})\\b`).test(text) ||
    /\b\d{1,2}\.\d{1,2}\.(?:\d{2,4}\b|(?!\d))|\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/.test(text)
  );
};

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

/** Opening and closing marks around a word: brackets and quotes, straight or curly. */
const OPENS = String.raw`[(\["'“„«]?`;
const CLOSES = String.raw`[)\]"'”“»]*`;
/** What may follow a title's last word: closing marks and punctuation. */
const TRAILING = /[\s.,;:!?)\]"'”“»–—-]+$/u;
/** What a cut leaves hanging at the end of what stays: separators, never a closing mark of its own. */
const SEPARATORS = /[\s,;:–—-]+$/u;

/** Weekdays listed or spanned ("Monday and Wednesday", "Montag, Mittwoch und Freitag", "Monday - Friday"). */
const DAY_LIST = `(?:${DAY_NAMES})(?:(?:,?\\s*(?:and|und|&)\\s+|,\\s*|\\s*(?:to|through|thru|bis|-|–)\\s*)(?:${DAY_NAMES}))*`;
/**
 * A repeat as the reader knows it (`statedRepeat`): "every Monday",
 * "every other week", "jeden ersten Freitag", "every weekday", "weekly",
 * "fortnightly", "once a month", "Mondays and Wednesdays", "werktags".
 */
const MONTH_FRAME_RUN = '(?:of (?:the|every|each) month|des monats|im monat|jeden monats)';
/** "every", with a gap or position; German "alle" only with the gap ("alle zwei Wochen" — "alle Jahre wieder" is a carol). */
const EVERY_LEAD = `(?:(?:${EVERY})\\s+(?:(?:${GAP}|${ORDINAL})\\s+)?|alle\\s+(?:${GAP})\\s+)`;
const REPEAT_RUN = [
  `${EVERY_LEAD}(?:${REPEAT_UNIT}|${DAY_SET}|${DAY_LIST})${DAY_PART}(?:\\s+${MONTH_FRAME_RUN})?`,
  `(?:${EVERY})\\s+\\d{1,2}(?:st|nd|rd|th|\\.)(?!\\d)`,
  `(?:(?:on|am)\\s+)?(?:(?:the|den)\\s+)?(?:\\d{1,2}(?:st|nd|rd|th|\\.)|(?:${ORDINAL})\\s+(?:${DAY_NAMES}))\\s+${MONTH_FRAME_RUN}`,
  FREQUENCY_WORDS.map((entry) => entry.words).join('|'),
  `(?:${HABITUAL_WEEKDAYS})(?:(?:,\\s*|\\s+(?:and|und|&)\\s+)(?:${HABITUAL_WEEKDAYS}))*`,
  String.raw`(?:(?:on|an|am)\s+)?(?:weekdays|weekends|werktags|werktagen|wochentags)`,
].join('|');

/**
 * The words that say when, as one run that ends a title: a day, a weekday
 * ("on Friday", "next Tuesday", "am Montag"), a part of the day after
 * "this" or "in the", a repeat (`REPEAT_RUN`), a month date ("Sep 1",
 * "1st of May", "17.10."), all day ("every Monday morning", "jeden
 * Morgen"). Clock times are read by `scan`, as for the start.
 */
const WHEN_AT_END = new RegExp(
  String.raw`(?:^|\s)${OPENS}(?:` +
    [
      `(?:${DAY_WORDS})${DAY_PART}`,
      `(?:(?:on|this|next|coming|am|nachsten|nachste|kommenden|kommende|diesen|diese)\\s+)?(?:${DAY_NAMES})${DAY_PART}`,
      String.raw`(?:this|in the)\s+(?:morning|afternoon|evening)|at night|morgens|vormittags|mittags|nachmittags|abends|nachts`,
      REPEAT_RUN,
      `(?:(?:on|am)\\s+)?(?:(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?(?:${MONTHS})\\.?|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}\\.\\d{1,2}\\.(?:\\d{2,4})?)(?:,?\\s+\\d{4})?`,
      String.raw`all[- ]day|whole day|ganztag(?:ig|s)?|(?:den\s+)?ganzen tag`,
    ].join('|') +
    String.raw`)${CLOSES}[.,;:!?–—-]*$`,
);

/** A day an end may name, written out: a month, "the end of March", a weekday, a date, a holiday. */
const END_RUN = [
  `(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?(?:${MONTHS}|year|month|week|\\d{4})`,
  `ende\\s+(?:${MONTHS}|des jahres|des monats|der woche|\\d{4})`,
  `(?:${MONTHS})\\.?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)?(?:,?\\s+\\d{4})?`,
  `(?:(?:next|this|coming|nachste[nrs]?|diese[nrs]?|kommende[nrs]?)\\s+)?(?:${DAY_NAMES}|week|month|year|woche|monat|jahr)`,
  'tomorrow|ubermorgen',
  HOLIDAYS,
  DAY_IN_NUMBERS,
].join('|');
/** A tail of a title, as one anchored pattern. */
const tailAtEnd = (body: string): RegExp =>
  new RegExp(String.raw`(?:^|\s)${OPENS}(?:${body})${CLOSES}[.,;:!?–—-]*$`);
/**
 * What may follow a repeat and belongs to it, not to the title: its end
 * ("until March", "bis zum 15.3.", "through Friday"), a count ("10
 * times") or a span ("for six weeks"). Each is taken only when the rule
 * holds it (`whenAtEnd`): "Vacation until Friday", "Push-ups 10 times",
 * "Gym 3x weekly" and "Beach house every year for a week" keep their
 * words.
 */
const UNTIL_TAIL = tailAtEnd(
  `(?:until|till|til|up to|ending|ends|bis|through|thru)\\s+${UNTIL_LEADS}(?:${END_RUN})(?:,?\\s+\\d{4})?(?![a-z\\d])`,
);
const COUNT_TAIL = tailAtEnd(
  `(?:\\d+|${COMPOUND_NUMBER}|${NUMBER_WORD}|${LENGTH_WORD})[\\s-]*(?:times|x|mal)`,
);
const SPAN_TAIL = tailAtEnd(RUNS_FOR.source);

/**
 * A day or a repeat said first ("Tomorrow: lunch with Tom", "Jeden
 * Dienstag um 18 Uhr Fußball"); a weekday first names the event ("Monday
 * standup"), and so does a frequency word ("Weekly sync").
 */
const DAY_AT_START = new RegExp(
  String.raw`^${OPENS}(?:(?:${DAY_WORDS})${DAY_PART}|${EVERY_LEAD}(?:${REPEAT_UNIT}|${DAY_SET}|${DAY_LIST})${DAY_PART}(?:\s+${MONTH_FRAME_RUN})?(?:\s+(?:on|am)\s+(?:(?:the|den)\s+)?(?:${DAY_LIST}|\d{1,2}(?:st|nd|rd|th|\.)?(?!\d)(?:\s+(?:of\s+)?(?:${MONTHS})\b)?|(?:${MONTHS})\s+\d{1,2}(?:st|nd|rd|th)?\b))?)${CLOSES}[.,;:!?–—-]*(?=\s)`,
);
/** The start of a repeat run, where a dash before it is no span ("Rent – once a month"). */
const REPEAT_AT_START = new RegExp(String.raw`^${OPENS}(?:${REPEAT_RUN})\b`);

/**
 * The word before a when that makes it the title's own, not the event's:
 * a span or a bound ("until Friday", "bis Montag", "Monday to Friday",
 * "after 5"), company or a list ("with Thu", "Mon and Wed"), a day's own
 * name ("Black Friday", "Easter Sunday", "Taco Tuesday", "Guten Morgen"),
 * a lead word the run did not take with it ("every …", "am Morgen" —
 * "in the morning", not "tomorrow"), or a day ruled out ("but not
 * Friday", "except Friday"). The code does not read those, so it leaves
 * them; a dash before the run is a span too ("Monday - Friday").
 */
const OWNS_WHEN =
  /^(?:until|till|til|bis|through|thru|to|from|von|between|zwischen|after|before|nach|vor|ab|seit|since|with|w|mit|and|und|or|oder|&|good|black|cyber|easter|palm|ash|holy|maundy|taco|throwback|giving|bowl|guten|by|for|last|past|previous|letzten?|not|except|but|than|nicht|ausser|ohne|keine?n?|every|each|jede[nmrs]?|am|on|this|next|coming|in|at|um|the|of)$/;

/** A word that leads into more when ("ab 18 Uhr", "until March", "for 6 weeks", "on the 15th"), after a day or repeat said first. */
const LEADS_WHEN =
  /^(?:until|till|til|bis|through|thru|to|from|von|between|zwischen|after|before|nach|vor|ab|seit|since|by|for|fur|on|am|at|um|of|and|und|or|oder|&|every|each|jede[nmrs]?|alle)$/;

/** A clock written as a bound ("until 5pm", "before 10", "after 5", "ab 9") is no start: the title's. */
const BOUND = /^(?:until|till|bis|to|before|vor|after|nach|ab)\b/;

/** The word that leads into a clock time ("at", "um"), taken off with it. */
const CLOCK_LEAD = /(?:^|\s)(?:at|um|gegen|@)$/;

/** A dash between two days or times: a span ("Monday - Friday"). */
const DASH = /^[–—-]$/;

/** A mark left hanging once the when after it is gone ("Lunch with Tom, tomorrow"). */
const HANGING = /^[,;:@&–—-]$/;

/** A word without its marks, for a comparison. */
const bare = (token: string): string => token.replaceAll(/[^\p{L}\p{N}&]/gu, '');

/**
 * Where the run of when-words that ends `text` starts, at a word;
 * undefined for none. A repeat's end, count or span counts only when the
 * rule holds it, read from the phrase the title came from (the model
 * may keep "until March" and drop "every Tuesday") or, without one, from
 * the text itself.
 */
const whenAtEnd = (text: string, phrase?: string): number | undefined => {
  const tail = text.replace(TRAILING, '').length;
  const starts = scan(text)
    .filter(({ end, index }) => index < tail && end >= tail && !BOUND.test(text.slice(index)))
    .map(({ index }) => (text[index - 1] === '(' ? index - 1 : index))
    .filter((index) => index === 0 || text[index - 1] === ' ')
    .map((index) => {
      const lead = CLOCK_LEAD.exec(text.slice(0, index).trimEnd());
      return lead ? lead.index + (lead[0].startsWith(' ') ? 1 : 0) : index;
    });
  const match = WHEN_AT_END.exec(text);
  if (match) {
    starts.push(match[0].startsWith(' ') ? match.index + 1 : match.index);
  }
  const source = phrase ?? text;
  const repeat = statedRepeat(source);
  const tails: ReadonlyArray<readonly [RegExp, boolean]> = [
    [UNTIL_TAIL, repeat !== undefined && statesUntil(source)],
    [COUNT_TAIL, repeat?.count !== undefined],
    [SPAN_TAIL, repeat !== undefined && spanEndsRepeat(repeat)],
  ];
  for (const [pattern, held] of tails) {
    const after = held ? pattern.exec(text) : null;
    if (after) {
      starts.push(after[0].startsWith(' ') ? after.index + 1 : after.index);
    }
  }
  return starts.length === 0 ? undefined : Math.min(...starts);
};

/** How many words of `text` a clock time at its very start takes ("at 1", "9am"); 0 for none. */
const clockAtStart = (text: string): number => {
  const ends = scan(text)
    .filter(({ index }) => index === 0 && !BOUND.test(text))
    .map(({ end }) => end)
    .filter((end) => end === text.length || /[\s.,;:!?)]/.test(text[end]!));
  return ends.length === 0 ? 0 : text.slice(0, Math.max(...ends)).split(' ').length;
};

/** The words that lead into a place ("at the office", "im Café"), with the article after them. */
const PLACE_LEADS = new Set([
  'at',
  'in',
  '@',
  'bei',
  'beim',
  'im',
  'am',
  'an',
  'auf',
  'ins',
  'zum',
  'zur',
  'chez',
]);
const ARTICLES = new Set([
  'the',
  'a',
  'an',
  'der',
  'die',
  'das',
  'dem',
  'den',
  'ein',
  'eine',
  'einem',
  'einer',
]);

/**
 * Where the event's place sits among the title's folded words, as
 * [first, past-the-last) ("Dinner at Ruby Tuesday"): its words are the
 * place's, never a when to trim. A place that is only a when
 * ("tomorrow") holds nothing.
 */
const placeSpan = (
  folded: ReadonlyArray<string>,
  place: string | undefined,
): readonly [number, number] | undefined => {
  const named =
    place === undefined ? [] : [...place.matchAll(/\S+/g)].map(([token]) => bare(words(token)));
  if (named.length === 0 || saysOnlyWhen(place!)) {
    return undefined;
  }
  for (let at = folded.length - named.length; at >= 0; at -= 1) {
    if (named.every((word, offset) => bare(folded[at + offset]!) === word)) {
      return [at, at + named.length];
    }
  }
  return undefined;
};

/**
 * The title's words without the when at its ends: the first and the
 * past-the-last word kept, and whether nothing but when is left. The
 * words of the event's place are never trimmed (`placeSpan`).
 */
const whenless = (
  title: string,
  place?: string,
  phrase?: string,
): { readonly first: number; readonly last: number; readonly onlyWhen: boolean } => {
  // Folded word by word and joined by one space, so a place in the text
  // is a count of words in the title.
  const folded = [...title.matchAll(/\S+/g)].map(([token]) => words(token));
  const held = placeSpan(folded, place);
  let last = folded.length;
  for (;;) {
    const text = folded.slice(0, last).join(' ');
    const start = whenAtEnd(text, phrase);
    if (start === undefined) {
      break;
    }
    const before = start === 0 ? 0 : text.slice(0, start).trimEnd().split(' ').length;
    const lead = before > 0 ? folded[before - 1]! : '';
    if (
      (held && before < held[1]) ||
      OWNS_WHEN.test(bare(lead)) ||
      (DASH.test(lead) && !REPEAT_AT_START.test(text.slice(start)))
    ) {
      break;
    }
    if (before === 0) {
      return { first: 0, last, onlyWhen: true };
    }
    last = before;
    while (last > 1 && HANGING.test(folded[last - 1]!)) {
      last -= 1;
    }
  }
  // A day said first, and a time right after it ("tomorrow at 1 lunch").
  const leading = DAY_AT_START.exec(folded.slice(0, last).join(' '));
  let first = leading ? leading[0].split(' ').length : 0;
  if (leading) {
    first += clockAtStart(folded.slice(first, last).join(' '));
    while (first < last && HANGING.test(folded[first]!)) {
      first += 1;
    }
    // More when the code does not read after it ("Jeden Freitag ab 18
    // Uhr …", "Every Monday until March: …"): the title stays whole.
    const next = first < last ? folded[first]! : '';
    if ((held && first > held[0]) || LEADS_WHEN.test(bare(next)) || DASH.test(next)) {
      first = 0;
    }
  }
  return first < last ? { first, last, onlyWhen: false } : { first: 0, last, onlyWhen: true };
};

/** The text says nothing but when ("tomorrow", "next Tuesday at 1pm"). */
export const saysOnlyWhen = (text: string): boolean => whenless(text).onlyWhen;

/**
 * The title without the words about when at its ends: "lunch with tom
 * tomorrow" is "lunch with tom", "Team standup every Monday at 9" is
 * "Team standup", "Zahnarzt Dienstag um 10" is "Zahnarzt", "Tomorrow:
 * lunch with Tom" is "lunch with Tom". The day, the time and the repeat
 * are read from the phrase itself, and the model leaves their words in
 * the title as often as not. Only the ends, and only a when the event
 * has: a weekday that opens a title names the event ("Monday standup"),
 * as does a day after its own name ("Black Friday"); a span or company
 * keeps its day ("until Friday", "with Thu"); words in the middle stay,
 * and a bare number is no time ("Room 9"). Given the event's place, its
 * words stay too ("Dinner at Ruby Tuesday"). A title that is nothing but
 * when stays as it is. Given the phrase the title came from, an end, a
 * count or a span at the end is the repeat's when the phrase's rule holds
 * it, even where the title dropped the repeat's own words ("Piano lesson
 * until March").
 */
export const trimWhen = (
  title: string,
  place?: string,
  { phrase }: { readonly phrase?: string } = {},
): string => {
  const tokens = [...title.matchAll(/\S+/g)];
  const { first, last, onlyWhen } = whenless(title, place, phrase);
  if (onlyWhen || (first === 0 && last === tokens.length)) {
    return title;
  }
  const end = tokens[last - 1]!;
  const trimmed = title
    .slice(tokens[first]!.index, end.index + end[0].length)
    .replace(SEPARATORS, '');
  return trimmed === '' ? title : trimmed;
};

/**
 * The title without the event's place at its end, when a word leads into
 * it ("Drinks with Jo at Loos Bar" with the place "Loos Bar" is "Drinks
 * with Jo"): the place has its own field. A place without such a word is
 * part of what the title says ("Trip to Vienna", "Fahrt nach Wien"), and
 * a title that is only the place stays.
 */
export const withoutPlace = (title: string, place: string | undefined): string => {
  const named =
    place === undefined ? [] : [...place.matchAll(/\S+/g)].map(([token]) => bare(words(token)));
  const tokens = [...title.matchAll(/\S+/g)];
  const folded = tokens.map(([token]) => bare(words(token)));
  let kept = folded.length - named.length;
  if (named.length === 0 || kept <= 0 || named.some((word, at) => folded[kept + at] !== word)) {
    return title;
  }
  if (kept > 1 && ARTICLES.has(folded[kept - 1]!) && PLACE_LEADS.has(folded[kept - 2]!)) {
    kept -= 2;
  } else if (PLACE_LEADS.has(folded[kept - 1]!)) {
    kept -= 1;
  } else {
    return title;
  }
  if (kept === 0) {
    return title;
  }
  const end = tokens[kept - 1]!;
  return title.slice(0, end.index + end[0].length).replace(SEPARATORS, '');
};

/** The words of a text, folded: its runs of letters and digits ("Tom's" is "tom" and "s"). */
const wordsOf = (text: string): ReadonlyArray<string> => words(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Words a model may add to a title that name no one and nothing: articles
 * and joints ("w/" written "with"), and what any event is ("Dentist
 * appointment").
 */
const GENERIC = new Set([
  'a',
  'am',
  'an',
  'and',
  'anruf',
  'appointment',
  'at',
  'call',
  'das',
  'dem',
  'den',
  'der',
  'die',
  'ein',
  'eine',
  'einen',
  'event',
  'for',
  'im',
  'in',
  'meeting',
  'mit',
  'of',
  'on',
  'termin',
  'the',
  'to',
  'treffen',
  'und',
  'with',
  'zum',
  'zur',
]);

/**
 * The title the phrase supports: the model's, when every word of it is
 * one the phrase says (or one that names no one, `GENERIC`), one of them
 * the phrase's own, and it names more than a when — else the phrase
 * itself. The model copies titles it
 * has seen ("Lunch with Sarah" for "lunch with tom tomorrow", the
 * prompt's old example) and keeps a when alone ("tomorrow" for "dinner
 * with tom tomorrow"); the user's own words are never wrong about who and
 * what.
 */
export const groundTitle = (title: string, phrase: string): string => {
  const said = new Set(wordsOf(phrase));
  const named = wordsOf(title);
  const fromPhrase = named.every((word) => said.has(word) || GENERIC.has(word));
  // Generic words alone stand only for a phrase that names nothing but
  // when ("Meeting" for "tomorrow at 9", not for "standup tomorrow at 9").
  const namesWhat =
    named.some((word) => said.has(word) && !GENERIC.has(word)) || whenless(phrase).onlyWhen;
  return fromPhrase && namesWhat && !whenless(title).onlyWhen ? title : phrase.trim();
};
