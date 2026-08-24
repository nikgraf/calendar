import { Temporal, type FindSlotsConstraints } from '@calendar/core';
import { ModelUnavailableError, type LanguageModel } from './model.ts';

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

const CALENDAR_HINT_DAYS = 14;

/** The quickAdd trick: dated weekdays to look up, never to compute. */
const upcomingDays = (referenceDate: string): string =>
  Array.from({ length: CALENDAR_HINT_DAYS }, (_, index) => {
    const date = Temporal.PlainDate.from(referenceDate).add({ days: index });
    const weekday = date.toLocaleString('en-US', { weekday: 'short' });
    return `${weekday} ${date.toString()}${index === 0 ? ' (today)' : ''}`;
  }).join(', ');

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
    'Daily bounds: "mornings" is 08:00–12:00, "afternoons" 12:00–17:00,',
    '"evenings" 17:00–21:00 (earliestTime/latestTime, 24-hour HH:MM).',
    'durationMinutes is required: "90 min" is 90, "2h" is 120, "half an',
    'hour" is 30 ("eineinhalb Stunden" is 90).',
    'daysOfWeek only when weekdays are named ("Tuesdays" → [2],',
    '"weekdays" → [1,2,3,4,5], "weekends" → [6,7]).',
    'title is what the time is FOR, if stated ("focus", "call with Anna"),',
    'in its original language. Omit fields the phrase does not state —',
    'never invent, never write placeholders like "unknown".',
    `Phrase: ${phrase}`,
  ].join('\n');

const TIME = /^(\d{1,2}):(\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLACEHOLDERS = new Set(['-', 'n/a', 'na', 'none', 'null', 'tbd', 'unknown', 'unspecified']);
const MAX_DURATION_MINUTES = 12 * 60;
const DEFAULT_WINDOW_DAYS = 7;

const realDate = (value: string | undefined): string | undefined => {
  if (!value || !DATE.test(value)) {
    return undefined;
  }
  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' }).toString();
  } catch {
    return undefined;
  }
};

const realTime = (value: string | undefined): string | undefined => {
  const match = value ? TIME.exec(value.trim()) : null;
  if (!match) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const realText = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text && !PLACEHOLDERS.has(text.toLowerCase()) ? text : undefined;
};

export type FindTimeResult =
  | {
      readonly constraints: FindSlotsConstraints;
      readonly kind: 'parsed';
      readonly title?: string;
    }
  | { readonly kind: 'rejected'; readonly reason: string };

/** Validates the raw parse; defaults the window to the coming week. */
export const normalizeFindTime = (
  parse: FindTimeParse,
  { referenceDate }: { referenceDate: string },
): FindTimeResult => {
  const duration = parse.durationMinutes;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return { kind: 'rejected', reason: 'Say how long you need — e.g. "90 min".' };
  }
  if (duration > MAX_DURATION_MINUTES) {
    return { kind: 'rejected', reason: 'Durations above 12 hours are not supported.' };
  }
  const start = realDate(parse.windowStartDate) ?? referenceDate;
  const fallbackEnd = Temporal.PlainDate.from(start)
    .add({ days: DEFAULT_WINDOW_DAYS - 1 })
    .toString();
  let end = realDate(parse.windowEndDate) ?? fallbackEnd;
  if (Temporal.PlainDate.compare(end, start) < 0) {
    end = fallbackEnd;
  }
  const earliestTime = realTime(parse.earliestTime);
  const latestTime = realTime(parse.latestTime);
  if (earliestTime && latestTime && latestTime <= earliestTime) {
    return { kind: 'rejected', reason: "That time window couldn't be read — try rephrasing." };
  }
  const daysOfWeek = parse.daysOfWeek?.filter(
    (dayNumber) => Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= 7,
  );
  const title = realText(parse.title);
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
  { phrase, referenceDate, timeZone }: { phrase: string; referenceDate: string; timeZone: string },
): Promise<FindTimeResult> => {
  if (!phrase.trim()) {
    return { kind: 'rejected', reason: 'Describe the time you need.' };
  }
  if ((await model.status()) !== 'ready') {
    throw new ModelUnavailableError('No on-device model is available.');
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
  return normalizeFindTime(raw as FindTimeParse, { referenceDate });
};
