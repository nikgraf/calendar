import { readFileSync } from 'node:fs';
import { type FindTimeResult, type Period, periodTimes } from '@calendar/ai';
import { finderWindowDates, Temporal } from '@calendar/core';
import { Schema } from 'effect';
import { fold } from './check.ts';

/**
 * The finder bench's cases: what find a time is told ("find 90 min for
 * focus next week, mornings", "wann habe ich morgen Nachmittag Zeit?")
 * and what a person means by it, in the product's terms — every part
 * stated, so a part the words leave out is checked too:
 *
 * - `duration`: minutes, or `"default"`, the length the finder already
 *   has (`FALLBACK_MINUTES`, the Assistant's own when nothing is said);
 * - `window`: named, so a case holds whatever day the bench runs on —
 *   `"default"` (the coming week, the finder's own), `"today"`,
 *   `"tomorrow"`, `"dayAfterTomorrow"`, `"thisWeek"` (to the coming
 *   Sunday), `"nextWeek"` (Monday to Sunday after), `"fortnight"` (two
 *   weeks from today), or one weekday (`{ "weekday": 4 }`, the coming one);
 * - `days`: the weekdays (ISO, Monday 1), or `null` for any;
 * - `bounds`: a meal's or a part of the day's window by its name
 *   (`{ "period": "morning" }`), clock times (`{ "earliest": "17:00" }`),
 *   or `null` for none;
 * - `title`: what the time is for, as a person would accept it (any of
 *   them, compared folded), or `null` when the words say nothing.
 *
 * The window and the weekdays are scored together, as the dates the
 * finder searches: "Wednesday" as the coming Wednesday's window and as
 * the coming week on Wednesdays searches the same day.
 */

/** The length the finder searches for when the words say none. */
export const FALLBACK_MINUTES = 60;

/** The finder's own window when the words name none: today and the six days after. */
const DEFAULT_WINDOW_DAYS = 7;

const NamedWindow = Schema.Literals([
  'dayAfterTomorrow',
  'default',
  'fortnight',
  'nextWeek',
  'thisWeek',
  'today',
  'tomorrow',
]);

const PeriodName = Schema.Literals([
  'afternoon',
  'breakfast',
  'brunch',
  'dinner',
  'evening',
  'lunch',
  'morning',
  'night',
]);

const FinderExpectation = Schema.Struct({
  bounds: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ period: PeriodName }),
      Schema.Struct({
        earliest: Schema.optional(Schema.String),
        latest: Schema.optional(Schema.String),
      }),
    ]),
  ),
  days: Schema.NullOr(Schema.Array(Schema.Number)),
  duration: Schema.Union([Schema.Number, Schema.Literal('default')]),
  title: Schema.NullOr(Schema.Array(Schema.String)),
  window: Schema.Union([NamedWindow, Schema.Struct({ weekday: Schema.Number })]),
});

export type FinderExpectation = typeof FinderExpectation.Type;

const FinderCase = Schema.Struct({
  expect: FinderExpectation,
  id: Schema.String,
  lang: Schema.Literals(['de', 'en']),
  text: Schema.String,
});

export type FinderCase = typeof FinderCase.Type;

const decodeCases = Schema.decodeUnknownSync(Schema.Array(FinderCase));

/** The cases in `finder.json`: one array, ids unique. */
export const loadFinderCases = (path: string): ReadonlyArray<FinderCase> => {
  const cases = decodeCases(JSON.parse(readFileSync(path, 'utf8')));
  const seen = new Set<string>();
  for (const finderCase of cases) {
    if (seen.has(finderCase.id)) {
      throw new Error(`finder.json: the id "${finderCase.id}" is there twice`);
    }
    seen.add(finderCase.id);
  }
  return cases;
};

/** The parts a finder answer is scored on, in the order a report lists them. */
export const FINDER_FIELDS = ['duration', 'dates', 'bounds', 'title'] as const;

export type FinderField = (typeof FINDER_FIELDS)[number];

interface Window {
  readonly windowEndDate: string;
  readonly windowStartDate: string;
}

const day = (today: string, days: number): string =>
  Temporal.PlainDate.from(today).add({ days }).toString();

const single = (date: string): Window => ({ windowEndDate: date, windowStartDate: date });

/**
 * The windows a case's window may be on `today`: one, but a weekday that
 * is today may mean today or the same day next week.
 */
export const expectedWindows = (
  window: FinderExpectation['window'],
  today: string,
): ReadonlyArray<Window> => {
  if (typeof window === 'object') {
    const ahead = (window.weekday - Temporal.PlainDate.from(today).dayOfWeek + 7) % 7;
    return ahead === 0 ? [single(today), single(day(today, 7))] : [single(day(today, ahead))];
  }
  switch (window) {
    case 'dayAfterTomorrow':
      return [single(day(today, 2))];
    case 'default':
      return [{ windowEndDate: day(today, DEFAULT_WINDOW_DAYS - 1), windowStartDate: today }];
    case 'fortnight':
      return [finderWindowDates('fortnight', today)];
    case 'nextWeek':
      return [finderWindowDates('nextWeek', today)];
    case 'thisWeek':
      return [finderWindowDates('week', today)];
    case 'today':
      return [single(today)];
    case 'tomorrow':
      return [single(day(today, 1))];
  }
};

/** The daily bounds a case's bounds are: a period's window, or the clock times it names. */
export const expectedBounds = (
  bounds: FinderExpectation['bounds'],
): { readonly earliestTime?: string; readonly latestTime?: string } => {
  if (bounds === null) {
    return {};
  }
  if ('period' in bounds) {
    const { earliestTime, latestTime } = periodTimes(bounds.period as Period);
    return { earliestTime, latestTime };
  }
  return {
    ...(bounds.earliest === undefined ? {} : { earliestTime: bounds.earliest }),
    ...(bounds.latest === undefined ? {} : { latestTime: bounds.latest }),
  };
};

/** What an answer gave for each part, as a report shows it. */
export type FinderGot = Readonly<Record<FinderField, string>>;

export interface FinderCheck {
  readonly failed: ReadonlyArray<FinderField>;
  readonly got: FinderGot;
}

const NONE = '-';

/** A window and its weekdays, the way a report shows them. */
const whenText = (window: Window, days: ReadonlyArray<number> | undefined): string =>
  `${window.windowStartDate}..${window.windowEndDate}${days === undefined || days.length === 0 ? '' : ` on ${sortedDays(days)}`}`;

/** The dates a window and its weekdays search (no weekdays: every day of the window). */
export const datesSearched = (window: Window, days: ReadonlyArray<number> | undefined): string => {
  const end = Temporal.PlainDate.from(window.windowEndDate);
  const dates: Array<string> = [];
  for (
    let date = Temporal.PlainDate.from(window.windowStartDate);
    Temporal.PlainDate.compare(date, end) <= 0 && dates.length <= 366;
    date = date.add({ days: 1 })
  ) {
    if (days === undefined || days.length === 0 || days.includes(date.dayOfWeek)) {
      dates.push(date.toString());
    }
  }
  return dates.length === 0 ? NONE : dates.join(',');
};

const sortedDays = (days: ReadonlyArray<number> | undefined): string =>
  days === undefined || days.length === 0 ? NONE : [...days].sort((a, b) => a - b).join(',');

const boundsText = (bounds: {
  readonly earliestTime?: string | undefined;
  readonly latestTime?: string | undefined;
}): string =>
  bounds.earliestTime === undefined && bounds.latestTime === undefined
    ? NONE
    : `${bounds.earliestTime ?? ''}–${bounds.latestTime ?? ''}`;

/**
 * An answer held against its case: each part right or wrong, and what it
 * was. A refused answer gets every part wrong — the finder searched for
 * nothing.
 */
export const checkFinder = (
  expect: FinderExpectation,
  result: FindTimeResult,
  today: string,
): FinderCheck => {
  if (result.kind === 'rejected') {
    const got = `refused: ${result.reason}`;
    return { failed: FINDER_FIELDS, got: { bounds: got, dates: got, duration: got, title: got } };
  }
  const { constraints, title } = result;
  const duration = expect.duration === 'default' ? FALLBACK_MINUTES : expect.duration;
  const dates = datesSearched(constraints, constraints.daysOfWeek);
  const expectedDates = expectedWindows(expect.window, today).map((window) =>
    datesSearched(window, expect.days ?? undefined),
  );
  const bounds = boundsText(constraints);
  const said = title === undefined ? NONE : fold(title);
  const accepted = expect.title?.map(fold);
  const right: Readonly<Record<FinderField, boolean>> = {
    bounds: bounds === boundsText(expectedBounds(expect.bounds)),
    dates: expectedDates.includes(dates),
    duration: constraints.durationMinutes === duration,
    title: accepted === undefined ? said === NONE : accepted.includes(said),
  };
  return {
    failed: FINDER_FIELDS.filter((field) => !right[field]),
    got: {
      bounds,
      dates: whenText(constraints, constraints.daysOfWeek),
      duration: String(constraints.durationMinutes),
      title: title ?? NONE,
    },
  };
};
