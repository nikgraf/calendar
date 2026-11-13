import type { RecurrenceFrequency } from '@calendar/core';

/**
 * One event as Apple's (or a served) model extracts it: the item shape
 * capture asks for (`capture.ts`), checked by `normalizeQuickAdd`.
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
