import { Temporal } from './temporal.ts';

/**
 * Milliseconds from `nowMs` until the next local midnight in `timeZone` —
 * the moment "today" changes and overdue tasks roll forward. Computed
 * through the zone so a DST night (23 or 25 hours long) lands on midnight
 * rather than 24 hours later.
 */
export const msUntilNextMidnight = (timeZone: string, nowMs: number): number => {
  const now = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(timeZone);
  const midnight = now.toPlainDate().add({ days: 1 }).toZonedDateTime(timeZone);
  return Math.max(midnight.epochMilliseconds - nowMs, 1);
};
