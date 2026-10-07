import type { RecurrenceFrequency } from '@calendar/core';
import { upcomingDays } from './shared.ts';

/** What the model is asked to extract from one phrase. */
export interface QuickAddParse {
  /** `YYYY-MM-DD`, resolved against the reference date in the prompt. */
  readonly date?: string;
  /** `HH:MM`, 24-hour. Absent for all-day or unspecified. */
  readonly endTime?: string;
  readonly isAllDay?: boolean;
  /** A to-do ("remind me to…", "todo: …") rather than an appointment; absent = event. */
  readonly kind?: 'event' | 'task';
  readonly location?: string;
  readonly recurrence?: {
    readonly count?: number;
    readonly freq?: RecurrenceFrequency;
    readonly interval?: number;
    readonly untilDate?: string;
  };
  readonly startTime?: string;
  readonly title?: string;
}

/** Guided-generation schema; kept in sync with QuickAddParse by hand. */
export const QUICK_ADD_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    date: { description: 'YYYY-MM-DD', type: 'string' },
    endTime: { description: 'HH:MM, 24-hour', type: 'string' },
    isAllDay: { type: 'boolean' },
    kind: { enum: ['event', 'task'], type: 'string' },
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
    'It is an event (kind "event") unless it describes something to do rather',
    'than attend — "remind me to", "todo", "don\'t forget to", "I need to" —',
    'then it is a task (kind "task"): a task has a date and maybe a time, no end.',
    `Today is ${referenceDate} in time zone ${timeZone}.`,
    'Resolve relative dates ("tomorrow", "next Tuesday") by picking from',
    `this list, never by computing: ${upcomingDays(referenceDate)}.`,
    'Use 24-hour HH:MM times: 1pm is 13:00, 12pm is 12:00, midnight is 00:00.',
    'Omit fields the phrase does not state — never invent a location, a time,',
    'or a repeat, and never write placeholders like "unknown".',
    'The title is only what the event is: leave date, time and location words',
    'out of it ("Lunch with Sarah next Tuesday at 1pm" has the title',
    '"Lunch with Sarah"). The phrase may be in any language; the title keeps',
    'its original language.',
    `${QUICK_ADD_PHRASE_MARKER}${phrase}`,
  ]
    .filter(Boolean)
    .join('\n');
