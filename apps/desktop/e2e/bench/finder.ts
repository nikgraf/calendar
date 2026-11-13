import { readFileSync } from 'node:fs';
import {
  type FindTimeParse,
  type FindTimeResult,
  normalizeFindTime,
  type Period,
  periodTimes,
} from '@calendar/ai';
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
 *   weeks from today), `"weekend"` (the coming one; on a weekend day, the
 *   rest of it or the next), or one weekday (`{ "weekday": 4 }`, the
 *   coming one; today's may mean today or a week on);
 * - `days`: the weekdays (ISO, Monday 1), or `null` for any;
 * - `bounds`: a meal's or a part of the day's window by its name
 *   (`{ "period": "morning" }`), clock times (`{ "earliest": "17:00" }`),
 *   a list of readings a person would accept, or `null` for none;
 * - `title`: what the time is for, as a person would accept it (any of
 *   them, compared folded; `""` accepts none), or `null` when the words
 *   say nothing.
 *
 * The window and the weekdays are scored together, as the dates the
 * finder searches: "Wednesday" as the coming Wednesday's window and as
 * the coming week on Wednesdays searches the same day. The bounds are
 * scored as the solver searches them, its own daytime (08:00–20:00) where
 * one is not said: "before 10" as 08:00–10:00 and as latest 10:00 is one
 * search.
 */

/** The length the finder searches for when the words say none. */
export const FALLBACK_MINUTES = 60;

/** The finder's own window when the words name none: today and the six days after. */
const DEFAULT_WINDOW_DAYS = 7;

/** The solver's daytime where a phrase sets no bound (`findSlots.ts`). */
const SOLVER_EARLIEST = '08:00';
const SOLVER_LATEST = '20:00';

const NamedWindow = Schema.Literals([
  'dayAfterTomorrow',
  'default',
  'fortnight',
  'nextWeek',
  'thisWeek',
  'today',
  'tomorrow',
  'weekend',
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

const Bound = Schema.Union([
  Schema.Struct({ period: PeriodName }),
  Schema.Struct({
    earliest: Schema.optional(Schema.String),
    latest: Schema.optional(Schema.String),
  }),
]);

type Bound = typeof Bound.Type;

const FinderExpectation = Schema.Struct({
  bounds: Schema.NullOr(Schema.Union([Bound, Schema.Array(Bound)])),
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

/**
 * A clock bound with one end open beyond the solver's daytime ("after
 * 9pm" alone) would be scored as an empty search: such a case names both ends.
 */
const openBeyondDaytime = (bound: Bound): boolean =>
  !('period' in bound) &&
  ((bound.latest === undefined && bound.earliest !== undefined && bound.earliest >= '20:00') ||
    (bound.earliest === undefined && bound.latest !== undefined && bound.latest <= '08:00'));

/** The cases in `finder.json`: one array, ids unique, every bound one the solver can search. */
export const loadFinderCases = (path: string): ReadonlyArray<FinderCase> => {
  const cases = decodeCases(JSON.parse(readFileSync(path, 'utf8')));
  const seen = new Set<string>();
  for (const finderCase of cases) {
    if (seen.has(finderCase.id)) {
      throw new Error(`finder.json: the id "${finderCase.id}" is there twice`);
    }
    seen.add(finderCase.id);
    const { bounds } = finderCase.expect;
    const each: ReadonlyArray<Bound> =
      bounds === null ? [] : Array.isArray(bounds) ? bounds : [bounds as Bound];
    if (each.some(openBeyondDaytime)) {
      throw new Error(
        `finder.json: "${finderCase.id}" leaves a bound open beyond 08:00–20:00; name both ends`,
      );
    }
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

const span = (today: string, from: number, to: number): Window => ({
  windowEndDate: day(today, to),
  windowStartDate: day(today, from),
});

/** The coming weekend; on a weekend day, what is left of it, or the next one. */
const weekends = (today: string): ReadonlyArray<Window> => {
  const weekday = Temporal.PlainDate.from(today).dayOfWeek;
  const nextSaturday = 13 - weekday;
  if (weekday <= 5) {
    return [span(today, 6 - weekday, 7 - weekday)];
  }
  return [span(today, 0, 7 - weekday), span(today, nextSaturday, nextSaturday + 1)];
};

/**
 * The windows a case's window may be on `today`: one, but a weekday that
 * is today may mean today or the same day next week, and a weekend that
 * has begun what is left of it or the next.
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
      return [span(today, 0, DEFAULT_WINDOW_DAYS - 1)];
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
    case 'weekend':
      return weekends(today);
  }
};

interface Bounds {
  readonly earliestTime?: string | undefined;
  readonly latestTime?: string | undefined;
}

const boundsOf = (bound: Bound): Bounds => {
  if ('period' in bound) {
    const { earliestTime, latestTime } = periodTimes(bound.period as Period);
    return { earliestTime, latestTime };
  }
  return {
    ...(bound.earliest === undefined ? {} : { earliestTime: bound.earliest }),
    ...(bound.latest === undefined ? {} : { latestTime: bound.latest }),
  };
};

/** The daily bounds a case accepts: a period's window or clock times, any of a list; none for `null`. */
export const expectedBounds = (bounds: FinderExpectation['bounds']): ReadonlyArray<Bounds> =>
  bounds === null
    ? [{}]
    : Array.isArray(bounds)
      ? bounds.map(boundsOf)
      : [boundsOf(bounds as Bound)];

/** What an answer gave for each part, as a report shows it. */
export type FinderGot = Readonly<Record<FinderField, string>>;

export interface FinderCheck {
  readonly failed: ReadonlyArray<FinderField>;
  readonly got: FinderGot;
}

const NONE = '-';

/** A window without the days before today. */
const fromToday = (window: Window, today: string): Window =>
  Temporal.PlainDate.compare(window.windowStartDate, today) < 0
    ? { ...window, windowStartDate: today }
    : window;

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

/** A window and its weekdays, the way a report shows them. */
const whenText = (window: Window, days: ReadonlyArray<number> | undefined): string =>
  `${window.windowStartDate}..${window.windowEndDate}${days === undefined || days.length === 0 ? '' : ` on ${sortedDays(days)}`}`;

/** Bounds as written, for the report. */
const boundsText = (bounds: Bounds): string =>
  bounds.earliestTime === undefined && bounds.latestTime === undefined
    ? NONE
    : `${bounds.earliestTime ?? ''}–${bounds.latestTime ?? ''}`;

/** Bounds as the solver searches them: its own daytime where one is not set. */
const searchedBounds = (bounds: Bounds): string =>
  `${bounds.earliestTime ?? SOLVER_EARLIEST}–${bounds.latestTime ?? SOLVER_LATEST}`;

export interface CheckOptions {
  /**
   * A case whose words give no length passes any length (the raw arm: the
   * schema has the model write one, and only the words' reader knows none
   * was said). Without it, only the finder's own (`FALLBACK_MINUTES`).
   */
  readonly anyLengthUnsaid?: boolean | undefined;
}

/**
 * An answer held against its case: each part right or wrong, and what it
 * was. A refused answer gets every part wrong — the finder searched for
 * nothing.
 */
export const checkFinder = (
  expect: FinderExpectation,
  result: FindTimeResult,
  today: string,
  { anyLengthUnsaid = false }: CheckOptions = {},
): FinderCheck => {
  if (result.kind === 'rejected') {
    const got = `refused: ${result.reason}`;
    return { failed: FINDER_FIELDS, got: { bounds: got, dates: got, duration: got, title: got } };
  }
  const { constraints, title } = result;
  const lengthRight =
    expect.duration === 'default'
      ? anyLengthUnsaid || constraints.durationMinutes === FALLBACK_MINUTES
      : constraints.durationMinutes === expect.duration;
  // From today on: the solver offers no slot in the past, so "this week" as
  // Monday to Sunday on a Wednesday searches what Wednesday to Sunday does.
  const dates = datesSearched(fromToday(constraints, today), constraints.daysOfWeek);
  const expectedDates = expectedWindows(expect.window, today).map((window) =>
    datesSearched(fromToday(window, today), expect.days ?? undefined),
  );
  const said = title === undefined ? '' : fold(title);
  const right: Readonly<Record<FinderField, boolean>> = {
    bounds: expectedBounds(expect.bounds).map(searchedBounds).includes(searchedBounds(constraints)),
    dates: expectedDates.includes(dates),
    duration: lengthRight,
    title: expect.title === null ? said === '' : expect.title.map(fold).includes(said),
  };
  return {
    failed: FINDER_FIELDS.filter((field) => !right[field]),
    got: {
      bounds: boundsText(constraints),
      dates: whenText(constraints, constraints.daysOfWeek),
      duration: String(constraints.durationMinutes),
      title: title ?? NONE,
    },
  };
};

/** How a model's answer is read: as the app does, word rules and all, or without them. */
export const ARMS = ['rules', 'raw'] as const;
export type Arm = (typeof ARMS)[number];

export interface ArmResult {
  readonly failed: ReadonlyArray<FinderField>;
  readonly got: FinderGot;
}

export interface FinderCaseReport {
  /** The model's answer as it came. */
  readonly answer: unknown;
  readonly arms: Readonly<Record<Arm, ArmResult>>;
  readonly error?: string | undefined;
  readonly id: string;
  readonly lang: string;
  readonly ms: number;
  readonly prompt: string;
  /** What the arms read, where a provider's wrapper changed the answer (every field required). */
  readonly read?: unknown;
  readonly text: string;
}

export interface ArmScore {
  readonly cases: number;
  readonly fields: Readonly<Record<FinderField, number>>;
}

export interface FinderReport {
  readonly cases: ReadonlyArray<FinderCaseReport>;
  /** What an empty answer scores in each arm on these cases: the floor the code's defaults give. */
  readonly floor?: Readonly<Record<Arm, number>> | undefined;
  readonly provider: string;
  /**
   * A report scored again (`MODEL_BENCH_RESCORE`): the run whose answers it
   * holds, and the cases it had that are gone or say other words now.
   */
  readonly rescored?:
    | {
        readonly left?: ReadonlyArray<string> | undefined;
        readonly sha: string;
        readonly when: string;
      }
    | undefined;
  readonly score: Readonly<Record<Arm, ArmScore>> & { readonly total: number };
  readonly settings?: string | undefined;
  readonly sha: string;
  readonly timeZone: string;
  readonly today: string;
  readonly when: string;
}

const NO_ANSWER: FindTimeResult = { kind: 'rejected', reason: 'the model gave no answer' };

/** An answer the code cannot read (a list where a number goes) is a refusal, not the end of the run. */
const normalized = (parse: FindTimeParse, options: Parameters<typeof normalizeFindTime>[1]) => {
  try {
    return normalizeFindTime(parse, options);
  } catch (error) {
    return {
      kind: 'rejected' as const,
      reason: `the answer could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
};

/**
 * One answer, read by each arm. Without the rules the code's defaults
 * still fill what the model leaves out: the coming week for a window, the
 * finder's own length for a length; and a case whose words give no length
 * passes any, since the schema has the model write one.
 */
export const readAnswer = (
  answer: unknown,
  finderCase: FinderCase,
  today: string,
): Record<Arm, ArmResult> => {
  const parse =
    typeof answer === 'object' && answer !== null ? (answer as FindTimeParse) : undefined;
  const read = (arm: Arm): FindTimeResult =>
    parse === undefined
      ? NO_ANSWER
      : normalized(
          arm === 'rules'
            ? parse
            : { ...parse, durationMinutes: parse.durationMinutes ?? FALLBACK_MINUTES },
          arm === 'rules'
            ? {
                fallbackDurationMinutes: FALLBACK_MINUTES,
                phrase: finderCase.text,
                referenceDate: today,
              }
            : { referenceDate: today },
        );
  return {
    raw: checkFinder(finderCase.expect, read('raw'), today, { anyLengthUnsaid: true }),
    rules: checkFinder(finderCase.expect, read('rules'), today),
  };
};

/** What an empty answer scores in each arm: how much the code's defaults give for nothing. */
export const floorOf = (cases: ReadonlyArray<FinderCase>, today: string): Record<Arm, number> => {
  const empty = cases.map((each) => readAnswer({}, each, today));
  return {
    raw: empty.filter((each) => each.raw.failed.length === 0).length,
    rules: empty.filter((each) => each.rules.failed.length === 0).length,
  };
};

export const scoreOf = (cases: ReadonlyArray<FinderCaseReport>): FinderReport['score'] => {
  const arm = (name: Arm): ArmScore => ({
    cases: cases.filter((each) => each.arms[name].failed.length === 0).length,
    fields: Object.fromEntries(
      FINDER_FIELDS.map((field) => [
        field,
        cases.filter((each) => !each.arms[name].failed.includes(field)).length,
      ]),
    ) as Record<FinderField, number>,
  });
  return { raw: arm('raw'), rules: arm('rules'), total: cases.length };
};

/**
 * A report scored again by the cases and the code as they are now: the
 * answers it holds, read on the day they were given. A case that is gone
 * or says other words now has no answer to score and is left out.
 */
export const rescoreFinder = (
  before: FinderReport,
  cases: ReadonlyArray<FinderCase>,
  stamp: { readonly sha: string; readonly when: string },
): { readonly left: ReadonlyArray<string>; readonly report: FinderReport } => {
  const byId = new Map(cases.map((each) => [each.id, each]));
  const left: Array<string> = [];
  const kept: Array<FinderCaseReport> = [];
  for (const old of before.cases) {
    const now = byId.get(old.id);
    if (now === undefined || now.text !== old.text) {
      left.push(old.id);
      continue;
    }
    kept.push({ ...old, arms: readAnswer(old.read ?? old.answer, now, before.today) });
  }
  const scored = cases.filter((each) => kept.some((report) => report.id === each.id));
  return {
    left,
    report: {
      ...before,
      cases: kept,
      floor: floorOf(scored, before.today),
      // A rescored report names the run it came from, however often it is scored again.
      rescored: {
        ...(left.length > 0 ? { left } : {}),
        sha: before.rescored?.sha ?? before.sha,
        when: before.rescored?.when ?? before.when,
      },
      score: scoreOf(kept),
      sha: stamp.sha,
      when: stamp.when,
    },
  };
};
