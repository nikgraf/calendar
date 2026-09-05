import type { RecurrenceFrequency, TaskRecurrence } from '@calendar/core';
import { useState } from 'react';

export type RepeatEnds = 'after' | 'never' | 'on';

/** Interval and occurrence count are small positive integers on both backends. */
export const REPEAT_NUMBER_MAX = 999;

/**
 * The interval / count fields are free text; the rule wants a positive
 * integer. Anything else (empty, "3.5", "1e20") reads as 1 rather than
 * reaching a backend — EventKit converts these with trapping casts.
 */
export const parseRepeatNumber = (text: string): number => {
  const value = Number.parseInt(text, 10);
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(REPEAT_NUMBER_MAX, value);
};

/** The validation message for a repeat number the form should refuse, or undefined. */
export const repeatNumberError = (text: string, label: string): string | undefined =>
  /^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= REPEAT_NUMBER_MAX
    ? undefined
    : `${label} must be a whole number between 1 and ${String(REPEAT_NUMBER_MAX)}.`;

/**
 * The repeat-rule form state shared by the event editor (RRULE for
 * Google) and the Reminders form (EKRecurrenceRule) — same chips, same
 * validation, one seed shape. `toSpec()` is the single exit: undefined
 * when repeat is off, otherwise the rule both backends accept (it is a
 * RecurrenceRuleSpec with the interval always present).
 */
export const useRepeatState = (
  seed?:
    | {
        readonly count?: number | undefined;
        readonly freq?: RecurrenceFrequency | undefined;
        readonly interval?: number | undefined;
        readonly untilDate?: string | undefined;
      }
    | undefined,
) => {
  const [repeat, setRepeat] = useState<RecurrenceFrequency | 'none'>(seed?.freq ?? 'none');
  const [repeatInterval, setRepeatInterval] = useState(String(seed?.interval ?? 1));
  const [repeatEnds, setRepeatEnds] = useState<RepeatEnds>(
    seed?.count ? 'after' : seed?.untilDate ? 'on' : 'never',
  );
  const [repeatCount, setRepeatCount] = useState(String(seed?.count ?? 10));
  const [repeatUntil, setRepeatUntil] = useState(seed?.untilDate ?? '');

  const toSpec = (): TaskRecurrence | undefined =>
    repeat === 'none'
      ? undefined
      : {
          ...(repeatEnds === 'after' ? { count: parseRepeatNumber(repeatCount) } : {}),
          freq: repeat,
          interval: parseRepeatNumber(repeatInterval),
          ...(repeatEnds === 'on' && repeatUntil ? { untilDate: repeatUntil } : {}),
        };

  return {
    repeat,
    repeatCount,
    repeatEnds,
    repeatInterval,
    repeatUntil,
    setRepeat,
    setRepeatCount,
    setRepeatEnds,
    setRepeatInterval,
    setRepeatUntil,
    toSpec,
  };
};
