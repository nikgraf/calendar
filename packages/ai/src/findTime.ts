import { Temporal, type FindSlotsConstraints } from '@calendar/core';
import {
  durationMinutesOf,
  groundBounds,
  groundDays,
  type Period,
  periodTimes,
  windowOf,
} from './grounding.ts';
import { ModelUnavailableError, type LanguageModel } from './model.ts';
import { meaningfulText, realDate, realTime, upcomingDays } from './shared.ts';

/** What the model is asked to extract from one constraint sentence. */
export interface FindTimeParse {
  /** ISO weekday numbers, 1 = Monday … 7 = Sunday. */
  readonly daysOfWeek?: ReadonlyArray<number>;
  readonly durationMinutes?: number;
  /** `HH:MM`, 24-hour daily bounds ("mornings" → 08:00–12:00). */
  readonly earliestTime?: string;
  readonly latestTime?: string;
  /** What the eventual event is for ("focus", "call with Anna"). */
  readonly title?: string;
  /** `YYYY-MM-DD` inclusive date window. */
  readonly windowEndDate?: string;
  readonly windowStartDate?: string;
}

/** Guided-generation schema; kept in sync with FindTimeParse by hand. */
export const FIND_TIME_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    daysOfWeek: {
      description: 'ISO weekday numbers, 1=Monday … 7=Sunday',
      items: { type: 'number' },
      type: 'array',
    },
    durationMinutes: { type: 'number' },
    earliestTime: { description: 'HH:MM, 24-hour', type: 'string' },
    latestTime: { description: 'HH:MM, 24-hour', type: 'string' },
    title: { type: 'string' },
    windowEndDate: { description: 'YYYY-MM-DD', type: 'string' },
    windowStartDate: { description: 'YYYY-MM-DD', type: 'string' },
  },
  required: ['durationMinutes'],
  type: 'object',
} as const;

/** The bounds line's vocabulary comes from the one table the normalizer reads. */
const bounds = (period: Period): string => {
  const { earliestTime, latestTime } = periodTimes(period);
  return `${earliestTime}–${latestTime}`;
};

export const buildFindTimePrompt = ({
  phrase,
  referenceDate,
  timeZone,
}: {
  phrase: string;
  referenceDate: string;
  timeZone: string;
}): string =>
  [
    'Extract scheduling constraints from the phrase — when to LOOK for free',
    'time, not an event itself.',
    `Today is ${referenceDate} in time zone ${timeZone}.`,
    'Resolve relative dates ("this week", "next week", "tomorrow") into a',
    'windowStartDate/windowEndDate pair by picking from this list, never by',
    `computing: ${upcomingDays(referenceDate)}.`,
    '"this week" ends on the coming Sunday; "next week" is Monday–Sunday',
    'after that.',
    `Daily bounds: "mornings" is ${bounds('morning')}, "afternoons" ${bounds('afternoon')},`,
    `"evenings" ${bounds('evening')}, "breakfast" ${bounds('breakfast')}, "lunch"`,
    `${bounds('lunch')}, "dinner" ${bounds('dinner')} (earliestTime/latestTime, 24-hour HH:MM).`,
    'durationMinutes is required: "90 min" is 90, "2h" is 120, "half an',
    'hour" is 30 ("eineinhalb Stunden" is 90).',
    'daysOfWeek only when weekdays are named ("Tuesdays" → [2],',
    '"weekdays" → [1,2,3,4,5], "weekends" → [6,7]).',
    'title is what the time is FOR, if stated ("focus", "call with Anna"),',
    'in its original language. Omit fields the phrase does not state —',
    'never invent, never write placeholders like "unknown".',
    `Phrase: ${phrase}`,
  ].join('\n');

const MAX_DURATION_MINUTES = 12 * 60;
const DEFAULT_WINDOW_DAYS = 7;

export type FindTimeResult =
  | {
      readonly constraints: FindSlotsConstraints;
      readonly kind: 'parsed';
      readonly title?: string;
    }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Validates the raw parse; defaults the window to the coming week. Given
 * the phrase, the parse is also held against it (`grounding.ts`): the
 * duration is the model's only when the phrase says how long, else the
 * fallback (the form's own); a window the phrase names in words is taken
 * from the words; the daily bounds stand only beside a written clock
 * time, are a named meal's or part of the day's window, or are dropped;
 * and weekdays count only when the phrase names them — the model answered
 * "Tuesday" to every phrase — unless it excludes days, which the code
 * cannot read, so the model's answer stands.
 */
export const normalizeFindTime = (
  parse: FindTimeParse,
  {
    fallbackDurationMinutes,
    phrase,
    referenceDate,
  }: {
    /** Searched for when the phrase does not say how long. */
    fallbackDurationMinutes?: number | undefined;
    /** The words the parse came from; when given, the parse is checked against them. */
    phrase?: string | undefined;
    referenceDate: string;
  },
): FindTimeResult => {
  // The phrase's own length first; the form's when it states none; the
  // model's only without either.
  const duration =
    phrase === undefined
      ? parse.durationMinutes
      : (durationMinutesOf(phrase) ?? fallbackDurationMinutes ?? parse.durationMinutes);
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return { kind: 'rejected', reason: 'Say how long you need — e.g. "90 min".' };
  }
  if (duration > MAX_DURATION_MINUTES) {
    return { kind: 'rejected', reason: 'Durations above 12 hours are not supported.' };
  }
  const window = phrase === undefined ? undefined : windowOf(phrase, referenceDate);
  const start = window?.windowStartDate ?? realDate(parse.windowStartDate) ?? referenceDate;
  const fallbackEnd = Temporal.PlainDate.from(start)
    .add({ days: DEFAULT_WINDOW_DAYS - 1 })
    .toString();
  let end = window?.windowEndDate ?? realDate(parse.windowEndDate) ?? fallbackEnd;
  if (Temporal.PlainDate.compare(end, start) < 0) {
    end = fallbackEnd;
  }
  const modelBounds = {
    earliestTime: realTime(parse.earliestTime),
    latestTime: realTime(parse.latestTime),
  };
  const { earliestTime, latestTime } =
    phrase === undefined ? modelBounds : groundBounds(modelBounds, phrase);
  if (earliestTime && latestTime && latestTime <= earliestTime) {
    return { kind: 'rejected', reason: "That time window couldn't be read — try rephrasing." };
  }
  const modelDays = parse.daysOfWeek?.filter(
    (dayNumber) => Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= 7,
  );
  const daysOfWeek = phrase === undefined ? modelDays : groundDays(modelDays, phrase);
  const title = meaningfulText(parse.title);
  return {
    constraints: {
      ...(daysOfWeek && daysOfWeek.length > 0 ? { daysOfWeek } : {}),
      durationMinutes: Math.round(duration),
      ...(earliestTime ? { earliestTime } : {}),
      ...(latestTime ? { latestTime } : {}),
      windowEndDate: end,
      windowStartDate: start,
    },
    kind: 'parsed',
    ...(title ? { title } : {}),
  };
};

/**
 * One constraint sentence in, solver constraints out. Only the model call
 * is impure — prompt building and normalization are testable around a
 * fake, exactly like parseQuickAdd.
 */
export const parseFindTime = async (
  model: LanguageModel,
  {
    fallbackDurationMinutes,
    phrase,
    referenceDate,
    timeZone,
  }: {
    /** The finder's current duration, searched for when the phrase does not say how long. */
    fallbackDurationMinutes?: number | undefined;
    phrase: string;
    referenceDate: string;
    timeZone: string;
  },
): Promise<FindTimeResult> => {
  if (!phrase.trim()) {
    return { kind: 'rejected', reason: 'Describe the time you need.' };
  }
  if ((await model.status()) !== 'ready') {
    throw new ModelUnavailableError({ message: 'No on-device model is available.' });
  }
  let raw: unknown;
  try {
    raw = await model.generateJson({
      jsonSchema: FIND_TIME_JSON_SCHEMA,
      prompt: buildFindTimePrompt({ phrase, referenceDate, timeZone }),
    });
  } catch {
    return { kind: 'rejected', reason: "That couldn't be read — try rephrasing." };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'rejected', reason: "That couldn't be read — try rephrasing." };
  }
  return normalizeFindTime(raw as FindTimeParse, {
    fallbackDurationMinutes,
    phrase,
    referenceDate,
  });
};
