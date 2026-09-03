import type { RecurrenceFrequency, TaskRecurrence } from '@calendar/core';
import { useState } from 'react';

export type RepeatEnds = 'after' | 'never' | 'on';

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
          ...(repeatEnds === 'after' ? { count: Number(repeatCount) || 1 } : {}),
          freq: repeat,
          interval: Number(repeatInterval) || 1,
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
