import type { RecurringScope } from '@calendar/core';
import { recurringTimesError, repeatScopeError } from './editorModel.ts';
import type { QuickAddItem } from './quickAddItem.ts';
import { recurrenceKey } from './repeatState.ts';

/**
 * What a stored event can take from a turn. A new item takes whatever
 * the words say; a saved one is bound by where it lives and, for a
 * series, by the scope the form is at — the rules Save checks, asked
 * here before a turn lands, so what cannot be saved is never shown as
 * if it were done.
 */
export interface TurnLimits {
  /** The event's calendar takes a guest list (an Apple calendar's does not: none added, none taken off). */
  readonly canInvite: boolean;
  /**
   * How the event repeats can be changed here: a stored series whose rule
   * the app holds. Not a single stored event (an update cannot give it a
   * rule), nor a series read through from Apple.
   */
  readonly repeatEditable: boolean;
  /** A stored series: the occurrence as the form opened it, and the scope it is at. */
  readonly series?:
    | {
        readonly opened: {
          readonly date: string;
          readonly endDate: string;
          readonly isAllDay: boolean;
        };
        readonly scope: RecurringScope;
      }
    | undefined;
}

const ruleOf = (item: QuickAddItem): string =>
  recurrenceKey(item.kind === 'event' ? item.prefill.recurrence : undefined);

/**
 * Why a turn on a stored event cannot be taken, in the sentence Save
 * would refuse it with, or undefined: a changed rule where none can be
 * written or at "This event"; what a series' times may not change to;
 * guests where the calendar holds none — invited or taken off, since
 * either is a guest list such a calendar's write refuses.
 */
export const turnRefusal = (
  before: QuickAddItem,
  after: QuickAddItem,
  guests: boolean,
  limits: TurnLimits,
): string | undefined => {
  const ruleChanged = ruleOf(before) !== ruleOf(after);
  if (ruleChanged && !limits.repeatEditable) {
    return 'How this event repeats can’t be changed here.';
  }
  const { series } = limits;
  const seriesError =
    series === undefined
      ? undefined
      : (repeatScopeError({ dirty: ruleChanged, isRecurring: true, scope: series.scope }) ??
        (after.kind === 'event'
          ? recurringTimesError({
              date: after.prefill.date,
              endDate: after.prefill.endDate ?? after.prefill.date,
              isAllDay: after.prefill.isAllDay,
              opened: series.opened,
              scope: series.scope,
            })
          : undefined));
  return (
    seriesError ??
    (guests && !limits.canInvite ? 'This calendar’s guests can’t be changed here.' : undefined)
  );
};
