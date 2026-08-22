import type { RecurrenceFrequency } from '@calendar/core';

/** What the model is asked to extract from one phrase. */
export interface QuickAddParse {
  /** `YYYY-MM-DD`, resolved against the reference date in the prompt. */
  readonly date?: string;
  /** `HH:MM`, 24-hour. Absent for all-day or unspecified. */
  readonly endTime?: string;
  readonly isAllDay?: boolean;
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
 * Builds the extraction prompt. The reference date and zone are injected
 * rather than assumed, so relative phrases ("next Tuesday") resolve
 * deterministically and the same phrase can be replayed in tests.
 */
export const buildQuickAddPrompt = ({
  calendarNames = [],
  phrase,
  referenceDate,
  timeZone,
}: {
  calendarNames?: ReadonlyArray<string> | undefined;
  phrase: string;
  /** `YYYY-MM-DD` — "today" from the user's point of view. */
  referenceDate: string;
  timeZone: string;
}): string =>
  [
    'Extract calendar event details from the phrase.',
    `Today is ${referenceDate} in time zone ${timeZone}.`,
    'Resolve relative dates ("tomorrow", "next Tuesday") against that date.',
    'Use 24-hour HH:MM times. Omit fields the phrase does not state —',
    'never invent a location or a time.',
    'The phrase may be in any language; the title keeps its original language.',
    calendarNames.length > 0 ? `Known calendars: ${calendarNames.join(', ')}.` : '',
    `Phrase: ${phrase}`,
  ]
    .filter(Boolean)
    .join('\n');
