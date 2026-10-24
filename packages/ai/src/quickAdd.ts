import type { RecurrenceFrequency } from '@calendar/core';
import { upcomingDays } from './shared.ts';

/**
 * What the model is asked to extract from one phrase. Whether the phrase
 * is a to-do is not asked: the normalizer reads the cue words itself
 * (`isTodoPhrase`), since the model called plain appointments tasks.
 */
export interface QuickAddParse {
  /** `YYYY-MM-DD`, resolved against the reference date in the prompt. */
  readonly date?: string | undefined;
  /** `HH:MM`, 24-hour. Absent for all-day or unspecified. */
  readonly endTime?: string | undefined;
  readonly isAllDay?: boolean | undefined;
  readonly location?: string | undefined;
  readonly recurrence?:
    | {
        readonly count?: number | undefined;
        readonly freq?: RecurrenceFrequency | undefined;
        readonly interval?: number | undefined;
        readonly untilDate?: string | undefined;
      }
    | undefined;
  readonly startTime?: string | undefined;
  readonly title?: string | undefined;
}

/** Guided-generation schema; kept in sync with QuickAddParse by hand. */
export const QUICK_ADD_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    date: { description: 'YYYY-MM-DD', type: 'string' },
    endTime: { description: 'HH:MM, 24-hour', type: 'string' },
    isAllDay: { type: 'boolean' },
    location: { type: 'string' },
    recurrence: {
      additionalProperties: false,
      properties: {
        count: { type: 'number' },
        freq: { enum: ['daily', 'weekly', 'monthly', 'yearly'], type: 'string' },
        interval: { type: 'number' },
        untilDate: { description: 'YYYY-MM-DD', type: 'string' },
      },
      type: 'object',
    },
    startTime: { description: 'HH:MM, 24-hour', type: 'string' },
    title: { type: 'string' },
  },
  required: ['title'],
  type: 'object',
} as const;

/**
 * The line the user's words follow in the prompt. Exported so the fixture
 * model can find them without knowing the rest of the prompt.
 */
export const QUICK_ADD_PHRASE_MARKER = 'Phrase: ';

/**
 * Builds the extraction prompt. The reference date and zone are injected
 * rather than assumed, so relative phrases ("next Tuesday") resolve
 * deterministically and the same phrase can be replayed in tests.
 *
 * The title rule has no example: the model copies an example's title
 * into any phrase of its shape ("Lunch with Sarah" for "lunch with tom
 * tomorrow"). The title is held against the phrase afterwards
 * (`groundTitle`), and the code takes the words about when off it.
 */
export const buildQuickAddPrompt = ({
  phrase,
  referenceDate,
  timeZone,
}: {
  phrase: string;
  /** `YYYY-MM-DD` — "today" from the user's point of view. */
  referenceDate: string;
  timeZone: string;
}): string =>
  [
    'Extract calendar details from the phrase.',
    `Today is ${referenceDate} in time zone ${timeZone}.`,
    'Resolve relative dates ("tomorrow", "next Tuesday") by picking from',
    `this list, never by computing: ${upcomingDays(referenceDate)}.`,
    'Use 24-hour HH:MM times: 1pm is 13:00, 12pm is 12:00, midnight is 00:00.',
    'A meal or a part of the day ("dinner", "morning") is not a time: give a',
    'startTime only for a clock time the phrase states.',
    'Omit fields the phrase does not state — never invent a location, a time,',
    'or a repeat, and never write placeholders like "unknown".',
    "The title is only what the event is, in the phrase's own words: leave",
    'date, time and location words out of it, but keep who it is with. A',
    'person is never the location. The phrase may be in any language; the',
    'title keeps its original language.',
    `${QUICK_ADD_PHRASE_MARKER}${phrase}`,
  ]
    .filter(Boolean)
    .join('\n');
