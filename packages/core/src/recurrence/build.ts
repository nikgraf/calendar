/**
 * Builds the RRULE line for the editor's repeat picker. The rule leans on
 * RFC 5545 defaults: without BYDAY/BYMONTHDAY the series recurs on the
 * weekday/day-of-month of DTSTART, which matches what the pickers offer.
 */

export type RecurrenceFrequency = 'daily' | 'monthly' | 'weekly' | 'yearly';

export interface RecurrenceRuleSpec {
  /** End after this many occurrences; wins over untilDate if both are set. */
  readonly count?: number | undefined;
  readonly freq: RecurrenceFrequency;
  /** Every n days/weeks/months/years; omitted when 1. */
  readonly interval?: number | undefined;
  /** Inclusive last day, 'YYYY-MM-DD'. */
  readonly untilDate?: string | undefined;
}

export const buildRecurrenceRule = (spec: RecurrenceRuleSpec, isAllDay: boolean): string => {
  const parts = [`FREQ=${spec.freq.toUpperCase()}`];
  if (spec.interval !== undefined && spec.interval > 1) {
    parts.push(`INTERVAL=${Math.floor(spec.interval)}`);
  }
  if (spec.count !== undefined && spec.count > 0) {
    parts.push(`COUNT=${Math.floor(spec.count)}`);
  } else if (spec.untilDate) {
    const compact = spec.untilDate.replaceAll('-', '');
    parts.push(`UNTIL=${isAllDay ? compact : `${compact}T235959Z`}`);
  }
  return `RRULE:${parts.join(';')}`;
};
