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
 * can see that it cannot read a construction (an excluded weekday, a
 * window with two ends), it has no opinion and the model's answer stands.
 */

/** Lower-case, accent-free text with straight apostrophes: what every pattern here is matched against. */
const words = (phrase: string): string => foldSearchText(phrase).replaceAll(/[‘’`]/g, "'");

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
  readonly period: Period;
  readonly times: PeriodTimes;
  readonly words: RegExp;
}> = [
  {
    period: 'breakfast',
    times: { earliestTime: '07:00', latestTime: '10:00', startTime: '08:00' },
    words: /\b(?:breakfast|fruhstuck)\b/,
  },
  {
    period: 'brunch',
    times: { earliestTime: '10:00', latestTime: '13:00', startTime: '11:00' },
    words: /\bbrunch\b/,
  },
  {
    period: 'lunch',
    times: { earliestTime: '11:30', latestTime: '14:00', startTime: '12:30' },
    words: /\b(?:lunch(?:time)?|mittag\w*)/,
  },
  {
    period: 'dinner',
    times: { earliestTime: '18:00', latestTime: '21:00', startTime: '19:00' },
    words: /\b(?:dinner|supper|abendessen)\b/,
  },
  {
    period: 'morning',
    times: { earliestTime: '08:00', latestTime: '12:00', startTime: '09:00' },
    words: /\b(?:mornings?|vormittags?)\b/,
  },
  {
    period: 'afternoon',
    times: { earliestTime: '12:00', latestTime: '17:00', startTime: '14:00' },
    words: /\b(?:afternoons?|nachmittags?)\b/,
  },
  {
    period: 'evening',
    times: { earliestTime: '17:00', latestTime: '21:00', startTime: '18:00' },
    words: /\b(?:evenings?|tonight|abends?|feierabend|after work|nach der arbeit)\b/,
  },
  {
    period: 'night',
    times: { earliestTime: '19:00', latestTime: '23:00', startTime: '20:00' },
    words: /\b(?:nights?|nachts?)\b/,
  },
];

/** The meal or part of the day the phrase names, if any. */
export const periodOf = (phrase: string): Period | undefined => {
  const text = words(phrase);
  return PERIODS.find((entry) => entry.words.test(text))?.period;
};

export const periodTimes = (period: Period): PeriodTimes =>
  PERIODS.find((entry) => entry.period === period)!.times;

// --- Clock times ----------------------------------------------------------

export interface ClockTime {
  /** am/pm, a 24-hour hour, noon or midnight: nothing left to guess. */
  readonly exact: boolean;
  /** 24-hour when `exact`; otherwise as written, 1–12, with the half of the day still open. */
  readonly hour: number;
  readonly minute: number;
}

interface Found extends ClockTime {
  /** Written as where something ends ("to 4", "–16:00", "until 5pm"). */
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

const minutes = ({ hour, minute }: ClockTime): number => hour * 60 + minute;

/**
 * The start of a range whose end carries the unit: "from 9 to 5pm" is
 * 09:00–17:00, not 21:00; the end's half of the day is the start's only
 * when the start then comes first ("2-4pm").
 */
const rangeStart = (
  hour: number,
  minute: number,
  meridiem: string | undefined,
  endMeridiem: string | undefined,
  end: Found | undefined,
): Found | undefined => {
  if (meridiem !== undefined) {
    return clock(hour, minute, meridiem);
  }
  if (endMeridiem !== undefined && end) {
    const shared = clock(hour, minute, endMeridiem);
    if (shared && minutes(shared) < minutes(end)) {
      return shared;
    }
  }
  return clock(hour, minute, undefined);
};

/** The hour before: "halb drei" and "quarter to three" both lead up to three. */
const before = (hour: number): number => (hour === 1 ? 12 : hour - 1);

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
  // at 1, um 7, @7, at three, um drei, at 3pm — not "at 17.10." (a date)
  {
    build: (match) => [clock(numberOf(match[1]!), minutesOf(match[2]), match[3])],
    regex: new RegExp(`(?:\\b(?:at|um)|@)\\s*${NUMBER}(?::(\\d{2}))?(?![./]\\d)${UNIT}\\b`, 'g'),
  },
  // half past two (pm)
  {
    build: (match) => [clock(numberOf(match[1]!), 30, match[2])],
    regex: new RegExp(`\\bhalf past ${NUMBER}${UNIT}\\b`, 'g'),
  },
  // halb drei (half to three: 2:30)
  {
    build: (match) => [clock(before(numberOf(match[1]!)), 30, match[2])],
    regex: new RegExp(`\\bhalb ${NUMBER}${UNIT}\\b`, 'g'),
  },
  // quarter past / to three
  {
    build: (match) => [
      match[1] === 'past'
        ? clock(numberOf(match[2]!), 15, match[3])
        : clock(before(numberOf(match[2]!)), 45, match[3]),
    ],
    regex: new RegExp(`\\b(?:a )?quarter (past|to) ${NUMBER}${UNIT}\\b`, 'g'),
  },
  // viertel nach / vor drei
  {
    build: (match) => [
      match[1] === 'nach'
        ? clock(numberOf(match[2]!), 15, match[3])
        : clock(before(numberOf(match[2]!)), 45, match[3]),
    ],
    regex: new RegExp(`\\bviertel (nach|vor) ${NUMBER}${UNIT}\\b`, 'g'),
  },
  // three o'clock
  {
    build: (match) => [clock(numberOf(match[1]!), 0, match[2])],
    regex: new RegExp(`\\b${NUMBER}\\s*o'?clock${UNIT}\\b`, 'g'),
  },
  {
    build: () => [clock(12, 0, 'pm')],
    regex: /\b(?:noon|midday|high noon)\b/g,
  },
  {
    build: () => [clock(0, 0, undefined)],
    regex: /\b(?:midnight|mitternacht)\b/g,
  },
  // from 2 to 4pm, von 14 bis 16 Uhr, between 9 and 11
  {
    build: (match) => {
      const end = clock(numberOf(match[5]!), minutesOf(match[6]), match[7], true);
      return [rangeStart(numberOf(match[1]!), minutesOf(match[2]), match[3], match[7], end), end];
    },
    regex: new RegExp(
      `\\b(?:from|von|between|zwischen)\\s+${NUMBER}(?::(\\d{2}))?${UNIT}\\s*${CLOSER}\\s*${NUMBER}(?::(\\d{2}))?${UNIT}`,
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
      return [rangeStart(Number(match[1]), minutesOf(match[2]), match[3], match[7], end), end];
    },
    regex: new RegExp(
      `\\b(\\d{1,2})(?::(\\d{2}))?${UNIT}\\s*[-–]\\s*(\\d{1,2})(?::(\\d{2}))?${UNIT}`,
      'g',
    ),
  },
  // until 5pm, bis 17 Uhr, to 4
  {
    build: (match) => [clock(numberOf(match[1]!), minutesOf(match[2]), match[3], true)],
    regex: new RegExp(`\\b(?:until|till|bis|to)\\s+${NUMBER}(?::(\\d{2}))?${UNIT}\\b`, 'g'),
  },
];

/** A time written right after a dash or "to" closes a span, whatever pattern read it. */
const CLOSES_BEFORE = /(?:[-–]|\b(?:to|until|till|bis))\s*$/;

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

/** Whether the phrase writes any clock time at all, a bare closer ("until 5pm") included. */
export const statesClockTime = (phrase: string): boolean => scan(words(phrase)).length > 0;

const minuteOfDay = (time: string): number => {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return hour * 60 + minute;
};

const format = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/** The 24-hour hours a stated time may mean: one when exact, else both halves of the day. */
const candidates = (time: ClockTime): ReadonlyArray<number> =>
  time.exact ? [time.hour] : time.hour === 12 ? [12, 0] : [time.hour, time.hour + 12];

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
  const hour = stated.hour === 12 ? 12 : stated.hour <= 6 ? stated.hour + 12 : stated.hour;
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
  /** Where the start came from; `none` means the phrase named no time and the event is all day. */
  readonly source: 'none' | 'period' | 'stated';
  readonly startTime?: string;
}

/**
 * The start the phrase supports. A stated clock time is resolved from the
 * phrase: by the meal or part of the day it names, or else by the model's
 * choice of the half of the day when that choice is one the stated hour
 * allows ("drinks at 9" may be 21:00 if the model says so; "breakfast at
 * 8" is 08:00 whatever it says). Only a meal or part of the day named:
 * its default. Nothing stated: nothing, whatever the model returned.
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

const dayOf = (token: string): number | undefined =>
  WEEKDAYS.find((entry) => new RegExp(`^(?:${entry.names})$`).test(token))?.day;

const weekdaysIn = (text: string): ReadonlyArray<number> =>
  WEEKDAYS.filter((entry) => new RegExp(`\\b(?:${entry.names})\\b`).test(text)).map(
    (entry) => entry.day,
  );

/** The ISO weekdays (1 = Monday … 7 = Sunday) the phrase names, in week order. */
export const namedWeekdays = (phrase: string): ReadonlyArray<number> => weekdaysIn(words(phrase));

const NEXT = /\b(?:next|nachsten?|kommenden?)\b/;

/**
 * The day the phrase states, if it states one: "tomorrow" and "today"
 * from the reference date, or a weekday — snapped forward from the
 * model's date when that date is not on it, so "next Friday" never lands
 * on a Thursday; "next <weekday>" said on that weekday is a week on.
 * Undefined when the phrase gives no day the code can read (a month and
 * day, or German "morgen", which is also "morning"), and the model's
 * date stands.
 */
export const groundDate = (
  modelDate: string | undefined,
  { phrase, referenceDate }: { readonly phrase: string; readonly referenceDate: string },
): string | undefined => {
  const text = words(phrase);
  const today = Temporal.PlainDate.from(referenceDate);
  if (/\b(?:day after tomorrow|ubermorgen)\b/.test(text)) {
    return today.add({ days: 2 }).toString();
  }
  if (/\btomorrow\b/.test(text)) {
    return today.add({ days: 1 }).toString();
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

// --- The finder's constraints ---------------------------------------------

const DAY_NAMES = WEEKDAYS.map((entry) => entry.names).join('|');
/** "Monday through Friday", "Freitag bis Montag": both ends named, every day between. */
const WEEKDAY_RANGE = new RegExp(
  `\\b(${DAY_NAMES})\\s*(?:to|through|thru|until|till|bis|-|–)\\s*(${DAY_NAMES})\\b`,
);
/** Days left out: a construction the code does not read, so the model's answer stands. */
const EXCLUDES_DAYS = /\b(?:except|but not|other than|ausser|ohne|nicht am|nicht an)\b/;

/**
 * The weekdays a finder phrase allows: a set word, a range, or the days
 * named; undefined for any day. A phrase that excludes days keeps the
 * model's answer — "any day except Tuesday" names Tuesday without
 * allowing it.
 */
export const groundDays = (
  modelDays: ReadonlyArray<number> | undefined,
  phrase: string,
): ReadonlyArray<number> | undefined => {
  const text = words(phrase);
  if (EXCLUDES_DAYS.test(text)) {
    return modelDays;
  }
  if (/\b(?:weekdays|wochentags|werktags|unter der woche)\b/.test(text)) {
    return [1, 2, 3, 4, 5];
  }
  if (/\b(?:weekends?|wochenende)\b/.test(text)) {
    return [6, 7];
  }
  const range = WEEKDAY_RANGE.exec(text);
  const from = range && dayOf(range[1]!);
  const to = range && dayOf(range[2]!);
  if (from !== undefined && to !== undefined && from && to) {
    const days: Array<number> = [from];
    for (let day = from; day !== to;) {
      day = (day % 7) + 1;
      days.push(day);
    }
    return days;
  }
  const days = weekdaysIn(text);
  return days.length === 0 ? undefined : days;
};

const DURATION = new RegExp(
  `\\b(?:\\d+(?:[.,]\\d+)?|${NUMBER_WORD}|an?|eine?r?)[\\s-]*(?:min|mins|minutes?|minuten|h|hr|hrs|hours?|stunden?|std)\\b|\\b(?:half an hour|halbe stunde|eineinhalb|anderthalb)\\b`,
);

/** Whether the phrase says how long ("90 min", "2h", "two hours", "90-minute", "zwei Stunden"). */
export const statesDuration = (phrase: string): boolean => DURATION.test(words(phrase));

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
  { dates: (today) => sameDay(today.add({ days: 1 })), words: /\btomorrow\b/ },
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

/** A day word used as one end of a span ("starting tomorrow", "until today"): not the window. */
const DAY_AS_END =
  /\b(?:starting|from|beginning|ab|until|till|bis|to)\s+(?:tomorrow|today|tonight|heute)\b/;

/**
 * The date window a finder phrase names in words the code can read: one
 * day, this or next week, a span of two weeks. Undefined when it names
 * none, more than one ("between today and tomorrow"), a day as one end
 * of a span, or a date the model has to resolve.
 */
export const windowOf = (
  phrase: string,
  referenceDate: string,
): { readonly windowEndDate: string; readonly windowStartDate: string } | undefined => {
  const text = words(phrase);
  const named = WINDOW_WORDS.filter((entry) => entry.words.test(text));
  if (named.length !== 1 || DAY_AS_END.test(text)) {
    return undefined;
  }
  return named[0]!.dates(Temporal.PlainDate.from(referenceDate), referenceDate);
};

/**
 * The finder's daily bounds the phrase supports: the model's where a
 * clock time is written ("after 5pm", "until 5pm", "between 2 and 4"),
 * the period's window where only a meal or part of the day is named,
 * none otherwise (the solver's daytime default).
 */
export const groundBounds = (
  bounds: { readonly earliestTime?: string | undefined; readonly latestTime?: string | undefined },
  phrase: string,
): { readonly earliestTime?: string; readonly latestTime?: string } => {
  if (statesClockTime(phrase)) {
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
