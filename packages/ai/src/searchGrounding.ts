import { foldSearchText, Temporal } from '@calendar/core';
import { isAllDayPhrase, mentionsDate, namedWeekdays } from './grounding.ts';

/**
 * What a search sentence says about when, read by the code. A search
 * looks back as often as ahead — "last week", "in October", "the past 3
 * days" — which the finder never needed, so these readers are the
 * search's own. Where the code sees a span it cannot read ("between
 * Monday and Friday", "since March", "before Christmas"), or more than
 * one window, it has no opinion and the model's dates stand.
 */

/** Lower-case, accent-free text with straight apostrophes and "ss" for ß. */
const words = (phrase: string): string =>
  foldSearchText(phrase)
    .replaceAll(/[‘’`]/g, "'")
    .replaceAll('ß', 'ss');

export interface SearchWindow {
  readonly from: string;
  readonly to: string;
}

const day = (date: Temporal.PlainDate): SearchWindow => {
  const iso = date.toString();
  return { from: iso, to: iso };
};

const span = (first: Temporal.PlainDate, last: Temporal.PlainDate): SearchWindow => ({
  from: first.toString(),
  to: last.toString(),
});

const monday = (date: Temporal.PlainDate): Temporal.PlainDate =>
  date.subtract({ days: date.dayOfWeek - 1 });

const month = (year: number, monthNumber: number): SearchWindow => {
  const first = new Temporal.PlainDate(year, monthNumber, 1);
  return span(first, first.add({ months: 1 }).subtract({ days: 1 }));
};

const MONTH_NAMES: ReadonlyArray<{ readonly month: number; readonly names: string }> = [
  // "jan" is left out: Jan is a name as often as a month.
  { month: 1, names: 'january|januar' },
  { month: 2, names: 'february|februar|feb' },
  { month: 3, names: 'march|marz|mar' },
  { month: 4, names: 'april|apr' },
  // "may" is a verb as often as a month: only with "in", "last", "next" … before it.
  { month: 5, names: 'mai' },
  { month: 6, names: 'june|juni|jun' },
  { month: 7, names: 'july|juli|jul' },
  { month: 8, names: 'august|aug' },
  { month: 9, names: 'september|sept|sep' },
  { month: 10, names: 'october|oktober|oct|okt' },
  { month: 11, names: 'november|nov' },
  { month: 12, names: 'december|dezember|dec|dez' },
];

const SMALL_NUMBERS: Readonly<Record<string, number>> = {
  acht: 8,
  drei: 3,
  eight: 8,
  five: 5,
  four: 4,
  funf: 5,
  sechs: 6,
  seven: 7,
  sieben: 7,
  six: 6,
  ten: 10,
  three: 3,
  two: 2,
  vier: 4,
  zehn: 10,
  zwei: 2,
};
const SMALL_NUMBER = Object.keys(SMALL_NUMBERS).join('|');

const amountOf = (token: string): number => SMALL_NUMBERS[token] ?? Number(token);

/** A span the code does not read: two ends, a start without an end, an end without a start. */
const SPAN =
  /\b(?:between|zwischen|from|von|since|seit|until|till|bis|(?<!day )before|(?<!day )after|vor|nach|ab|ago)\b/;

/** A month with a day beside it ("Oct 20", "20 October", "20. Oktober"): one day, the model's. */
const MONTH_DAY = new RegExp(
  `\\b\\d{1,2}\\.?\\s*(?:${MONTH_NAMES.map((entry) => entry.names).join('|')}|may)\\b|\\b(?:${MONTH_NAMES.map((entry) => entry.names).join('|')}|may)\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?!\\d)`,
);

type Reader = (text: string, today: Temporal.PlainDate) => SearchWindow | undefined;

const READERS: ReadonlyArray<Reader> = [
  (text, today) =>
    /\b(?:day after tomorrow|ubermorgen)\b/.test(text) ? day(today.add({ days: 2 })) : undefined,
  (text, today) =>
    /\b(?:day before yesterday|vorgestern)\b/.test(text)
      ? day(today.subtract({ days: 2 }))
      : undefined,
  (text, today) =>
    /\b(?<!day after )tomorrow\b/.test(text) ? day(today.add({ days: 1 })) : undefined,
  (text, today) =>
    /\b(?<!day before )yesterday\b|\bgestern\b/.test(text)
      ? day(today.subtract({ days: 1 }))
      : undefined,
  (text, today) => (/\b(?:today|heute|tonight)\b/.test(text) ? day(today) : undefined),
  (text, today) =>
    /\b(?:this week|diese woche|dieser woche)\b/.test(text)
      ? span(monday(today), monday(today).add({ days: 6 }))
      : undefined,
  (text, today) =>
    /\b(?:next week|nachste woche|nachsten woche|kommende woche|kommenden woche)\b/.test(text)
      ? span(monday(today).add({ days: 7 }), monday(today).add({ days: 13 }))
      : undefined,
  (text, today) =>
    /\b(?:last week|past week|previous week|letzte woche|letzten woche|vergangene woche|vergangenen woche|vorige woche|vorigen woche)\b/.test(
      text,
    )
      ? span(monday(today).subtract({ days: 7 }), monday(today).subtract({ days: 1 }))
      : undefined,
  (text, today) =>
    /\b(?:this month|diesen monat|diesem monat)\b/.test(text)
      ? month(today.year, today.month)
      : undefined,
  (text, today) => {
    if (!/\b(?:next month|nachsten monat|kommenden monat)\b/.test(text)) {
      return undefined;
    }
    const next = today.with({ day: 1 }).add({ months: 1 });
    return month(next.year, next.month);
  },
  (text, today) => {
    if (
      !/\b(?:last month|past month|previous month|letzten monat|vergangenen monat|vorigen monat)\b/.test(
        text,
      )
    ) {
      return undefined;
    }
    const last = today.with({ day: 1 }).subtract({ months: 1 });
    return month(last.year, last.month);
  },
  (text, today) =>
    /\b(?:this year|dieses jahr|diesem jahr)\b/.test(text)
      ? span(new Temporal.PlainDate(today.year, 1, 1), new Temporal.PlainDate(today.year, 12, 31))
      : undefined,
  (text, today) =>
    /\b(?:last year|previous year|letztes jahr|letzten jahr|vergangenes jahr|voriges jahr)\b/.test(
      text,
    )
      ? span(
          new Temporal.PlainDate(today.year - 1, 1, 1),
          new Temporal.PlainDate(today.year - 1, 12, 31),
        )
      : undefined,
  (text, today) =>
    /\b(?:next year|nachstes jahr|nachsten jahr|kommendes jahr)\b/.test(text)
      ? span(
          new Temporal.PlainDate(today.year + 1, 1, 1),
          new Temporal.PlainDate(today.year + 1, 12, 31),
        )
      : undefined,
  // "the past 3 days", "the last two weeks", "die letzten 3 Monate": up to today.
  (text, today) => {
    const match = new RegExp(
      `\\b(?:last|past|previous|letzten|vergangenen)\\s+(\\d{1,2}|${SMALL_NUMBER})\\s+(days?|weeks?|months?|tagen?|wochen|monaten?)\\b`,
    ).exec(text);
    if (!match) {
      return undefined;
    }
    const amount = amountOf(match[1]!);
    const unit = match[2]!;
    const first = /^(?:days?|tagen?)$/.test(unit)
      ? today.subtract({ days: amount - 1 })
      : /^(?:weeks?|wochen)$/.test(unit)
        ? today.subtract({ days: amount * 7 - 1 })
        : today.subtract({ months: amount }).add({ days: 1 });
    return span(first, today);
  },
  // "last Friday", "letzten Freitag": the latest one before today.
  (text, today) => {
    if (!/\b(?:last|past|previous|letzten|vergangenen|vorigen)\s+\w+/.test(text)) {
      return undefined;
    }
    const [weekday, ...more] = namedWeekdays(text);
    if (weekday === undefined || more.length > 0) {
      return undefined;
    }
    const back = (today.dayOfWeek - weekday + 7) % 7 || 7;
    return day(today.subtract({ days: back }));
  },
  // A month: this year's; "last October" the latest before this month,
  // "next October" the first after it, "October 2025" that year's. Two
  // months ("October to November") are a span: the model's.
  (text, today) => {
    const named = MONTH_NAMES.filter((entry) =>
      new RegExp(`\\b(?:${entry.month === 5 ? 'mai' : entry.names})\\b`).test(text),
    );
    if (named.length > 1) {
      return undefined;
    }
    for (const entry of MONTH_NAMES) {
      const names =
        entry.month === 5 ? 'mai|(?<=(?:in|im|during|last|next|this) )may' : entry.names;
      // After "with" a month is a person: April, June, August.
      const match = new RegExp(
        `\\b(last|previous|letzten|next|nachsten|kommenden)?\\s*(?<!(?:with|mit|and|und) )(?:${names})\\b(?:\\s+(\\d{4}))?`,
      ).exec(text);
      if (!match) {
        continue;
      }
      if (match[2]) {
        return month(Number(match[2]), entry.month);
      }
      const qualifier = match[1];
      if (qualifier !== undefined && /^(?:last|previous|letzten)$/.test(qualifier)) {
        return month(entry.month < today.month ? today.year : today.year - 1, entry.month);
      }
      if (qualifier !== undefined) {
        return month(entry.month > today.month ? today.year : today.year + 1, entry.month);
      }
      return month(today.year, entry.month);
    }
    return undefined;
  },
];

/** Day words, each counted once ("today" and "tonight" are one). */
const DAY_WORDS: ReadonlyArray<RegExp> = [
  /\b(?:today|heute|tonight)\b/,
  /\b(?<!day after )tomorrow\b|\bmorgen\b/,
  /\b(?<!day before )yesterday\b|\bgestern\b/,
  /\b(?:day after tomorrow|ubermorgen)\b/,
  /\b(?:day before yesterday|vorgestern)\b/,
];

const PERIOD =
  /\b(?:this|next|last|past|previous|coming|diese[nmrs]?|nachste[nmrs]?|kommende[nmrs]?|letzte[nmrs]?|vergangene[nmrs]?|vorige[nmrs]?)\s+(?:week|month|year|woche|monat|jahr)\b/g;

/**
 * How many things in the sentence name days: day words, weeks, months
 * and years, weekdays, month names, written dates. One reader reads one;
 * a sentence naming two ("Friday next week", "today through Friday") is a
 * composite the code does not read, and the model's dates stand.
 */
const dateMentions = (text: string, phrase: string): number =>
  DAY_WORDS.filter((pattern) => pattern.test(text)).length +
  (text.match(PERIOD) ?? []).length +
  namedWeekdays(phrase).length +
  MONTH_NAMES.filter((entry) =>
    new RegExp(
      `\\b(?<!(?:with|mit|and|und) )(?:${entry.month === 5 ? 'mai' : entry.names})\\b`,
    ).test(text),
  ).length +
  (text.match(/\b\d{1,2}[./]\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/g) ?? []).length;

/**
 * The days a search sentence names in words the code reads: a day
 * (yesterday, today, tomorrow and the days either side), this / last /
 * next week, month or year, the past N days, weeks or months, last
 * <weekday>, a month by name. Undefined when it names none, more than
 * one, a span with an end ("between", "since", "until", "before"), or a
 * month with a day beside it — the model's dates stand then.
 */
export const searchWindowOf = (phrase: string, referenceDate: string): SearchWindow | undefined => {
  const text = words(phrase);
  if (SPAN.test(text) || MONTH_DAY.test(text) || dateMentions(text, phrase) > 1) {
    return undefined;
  }
  const today = Temporal.PlainDate.from(referenceDate);
  const found = READERS.map((read) => read(text, today)).filter(
    (window): window is SearchWindow => window !== undefined,
  );
  // Two readers naming the same days ("today" and "tonight") count once.
  const distinct = new Map(found.map((window) => [`${window.from}..${window.to}`, window]));
  return distinct.size === 1 ? [...distinct.values()][0] : undefined;
};

/** The sentence says when, in some form — the code's or one the model resolves. */
export const statesSearchDate = (phrase: string, referenceDate: string): boolean => {
  const text = words(phrase);
  return (
    searchWindowOf(phrase, referenceDate) !== undefined ||
    mentionsDate(phrase) ||
    // "before last week": a period the code may not read as a whole is still a when.
    new RegExp(PERIOD.source).test(text) ||
    namedWeekdays(phrase).length > 0 ||
    // German "morgen" (tomorrow, and "morning"): the code does not read it,
    // the model's dates for it count.
    /\b(?:yesterday|today|tomorrow|tonight|gestern|heute|morgen|vorgestern|ubermorgen|since|seit|ago|until|bis)\b/.test(
      text,
    ) ||
    // A signed day count, and an ISO date: the fixture grammar's days.
    /(?:^|\s)[+-]\d+\b|\b\d{4}-\d{2}-\d{2}\b/.test(text)
  );
};

/** Dates taken away: "any time", "all time", "egal wann". */
export const clearsSearchDates = (phrase: string): boolean =>
  /\b(?:any ?time|all time|whenever|egal wann|jederzeit)\b/.test(words(phrase));

/** Tasks or events only, from the words alone; undefined when neither or both are named. */
export const searchKindOf = (phrase: string): 'event' | 'task' | 'any' | undefined => {
  const text = words(phrase);
  if (/\b(?:events and tasks|tasks and events|everything|alles)\b/.test(text)) {
    return 'any';
  }
  // Plurals, or a singular after "only": "task review" is a title's words.
  const task =
    /\b(?:tasks|to-?dos|reminders|aufgaben|erinnerungen)\b|\b(?:only|just|nur)\s+(?:a\s+)?(?:task|to-?do|reminder|aufgabe)\b/.test(
      text,
    );
  const event =
    /\b(?:events|meetings|appointments|termine|veranstaltungen)\b|\b(?:only|just|nur)\s+(?:an?\s+)?(?:event|meeting|appointment|termin)\b/.test(
      text,
    );
  return task === event ? undefined : task ? 'task' : 'event';
};

/** All-day only (true), timed only (false), or nothing said. */
export const searchAllDayOf = (phrase: string): boolean | undefined => {
  const text = words(phrase);
  if (/\b(?:not all[- ]day|timed|with a time|mit uhrzeit|nicht ganztag\w*)\b/.test(text)) {
    return false;
  }
  return isAllDayPhrase(phrase) ? true : undefined;
};

/**
 * The words carry a filter the model can read — when, with whom, where,
 * which kind, a calendar or list — rather than only words to look for.
 * The router behind the desktop's Enter and the iOS Search key: plain
 * words stay plain search, a sentence with a cue is a turn. A bar is the
 * fixture grammar's.
 */
export const isSearchFilterPhrase = (phrase: string): boolean => {
  const text = words(phrase);
  return (
    text.includes('|') ||
    mentionsDate(phrase) ||
    namedWeekdays(phrase).length > 0 ||
    searchKindOf(phrase) !== undefined ||
    isAllDayPhrase(phrase) ||
    searchAllDayOf(phrase) !== undefined ||
    clearsSearchDates(phrase) ||
    /\b(?:yesterday|today|tomorrow|tonight|gestern|heute|morgen|vorgestern|ubermorgen|since|seit|ago)\b/.test(
      text,
    ) ||
    /\b(?:last|past|previous|letzten|vergangenen|vorigen)\s+\w+/.test(text) ||
    /\b(?:with|mit|in|at|near|bei|im|am)\s+\S/.test(text) ||
    // "Groceries list", "Work calendar": a container by name.
    /\b(?:calendars?|kalender|lists?|listen?)\b/.test(text)
  );
};
