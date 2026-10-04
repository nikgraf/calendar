import { RRuleTemporal } from 'rrule-temporal';
import {
  addDaysToPlainDate,
  daysBetweenPlainDates,
  plainDateToUtcMs,
  toZonedDateTime,
  type EpochMs,
} from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';

/**
 * The slice of a recurring master event the expansion needs. Google stores the
 * recurrence as raw RFC 5545 lines (RRULE/EXRULE/RDATE/EXDATE) without DTSTART;
 * DTSTART is derived from the event start.
 */
export interface RecurrenceMaster {
  readonly endDate?: string | undefined;
  readonly endUtc: EpochMs;
  readonly id: string;
  readonly isAllDay: boolean;
  readonly recurrence: ReadonlyArray<string>;
  readonly startDate?: string | undefined;
  /** IANA zone the rule's wall-clock times are anchored to. */
  readonly startTimeZone: string;
  readonly startUtc: EpochMs;
}

export interface EventInstance {
  readonly endDate?: string | undefined;
  readonly endUtc: EpochMs;
  readonly masterId: string;
  /**
   * The occurrence's original start — identifies the instance within its
   * series and matches Google's originalStartTime on override events.
   */
  readonly originalStartUtc: EpochMs;
  readonly startDate?: string | undefined;
  readonly startUtc: EpochMs;
}

const icsWallTime = (zonedDateTime: Temporal.ZonedDateTime): string =>
  zonedDateTime.toPlainDateTime().toString({ fractionalSecondDigits: 0 }).replaceAll(/[:-]/g, '');

/**
 * rrule-temporal throws past this many iterations. Rules without COUNT
 * fast-forward to the window, and most COUNT shapes jump straight to it
 * through the library's COUNT query plan; the shapes without a plan
 * (plain MONTHLY, BYSETPOS, …) walk from DTSTART, so only very long such
 * series and pathological rules ever approach it. assembleWindow skips
 * such a master rather than failing the whole window.
 */
export const EXPANSION_MAX_ITERATIONS = 10_000;

/**
 * A set of only RDATE lines has no rule, and rrule-temporal will not build
 * one without FREQ. This rule yields exactly DTSTART — the first instance
 * of every recurrence set (RFC 5545) — and the library adds the RDATEs and
 * takes the EXDATEs away as it does for any rule.
 */
export const DTSTART_ONLY_RULE = 'RRULE:FREQ=DAILY;COUNT=1';

export const buildRuleString = (master: RecurrenceMaster): string => {
  const dtstart = master.isAllDay
    ? `DTSTART;VALUE=DATE:${(master.startDate ?? '').replaceAll('-', '')}`
    : `DTSTART;TZID=${master.startTimeZone}:${icsWallTime(
        toZonedDateTime(master.startUtc, master.startTimeZone),
      )}`;
  // Google never includes DTSTART in recurrence[], but guard against it anyway.
  const lines = master.recurrence.filter((line) => !line.startsWith('DTSTART'));
  const hasRule = lines.some((line) => line.toUpperCase().startsWith('RRULE:'));
  return [dtstart, ...(hasRule ? [] : [DTSTART_ONLY_RULE]), ...lines].join('\n');
};

/**
 * Expands a recurring master into concrete instances overlapping
 * [rangeStartUtc, rangeEndUtc). Occurrences whose original start is in
 * `excludeOriginalStarts` are dropped — pass the originalStartUtc of every
 * override row (including cancelled ones) so overrides shadow their generated
 * instance.
 */
export const expandRecurringEvent = (
  master: RecurrenceMaster,
  rangeStartUtc: EpochMs,
  rangeEndUtc: EpochMs,
  excludeOriginalStarts?: ReadonlySet<EpochMs>,
): Array<EventInstance> => {
  const rule = new RRuleTemporal({
    maxIterations: EXPANSION_MAX_ITERATIONS,
    rruleString: buildRuleString(master),
    temporal: Temporal,
  });

  const durationMs = master.isAllDay ? 0 : master.endUtc - master.startUtc;
  const durationDays =
    master.isAllDay && master.startDate && master.endDate
      ? daysBetweenPlainDates(master.startDate, master.endDate)
      : 0;

  // Widen the query window backwards so occurrences that start before the
  // range but overlap into it are still found.
  const lookBehindMs = master.isAllDay ? durationDays * 24 * 60 * 60 * 1000 : durationMs;
  const windowStart = Temporal.Instant.fromEpochMilliseconds(
    rangeStartUtc - lookBehindMs,
  ).toZonedDateTimeISO(master.startTimeZone);
  const windowEnd = Temporal.Instant.fromEpochMilliseconds(rangeEndUtc).toZonedDateTimeISO(
    master.startTimeZone,
  );

  const instances: Array<EventInstance> = [];
  for (const occurrence of rule.between(windowStart, windowEnd, true)) {
    const startUtc = occurrence.toInstant().epochMilliseconds;
    if (excludeOriginalStarts?.has(startUtc)) {
      continue;
    }

    if (master.isAllDay) {
      const startDate = occurrence.toPlainDate().toString();
      const endDate = addDaysToPlainDate(startDate, durationDays);
      const startDayUtc = plainDateToUtcMs(startDate);
      const endDayUtc = plainDateToUtcMs(endDate);
      if (startDayUtc < rangeEndUtc && endDayUtc > rangeStartUtc) {
        instances.push({
          endDate,
          endUtc: endDayUtc,
          masterId: master.id,
          originalStartUtc: startDayUtc,
          startDate,
          startUtc: startDayUtc,
        });
      }
      continue;
    }

    const endUtc = startUtc + durationMs;
    if (startUtc < rangeEndUtc && endUtc > rangeStartUtc) {
      instances.push({
        endUtc,
        masterId: master.id,
        originalStartUtc: startUtc,
        startUtc,
      });
    }
  }
  return instances;
};
