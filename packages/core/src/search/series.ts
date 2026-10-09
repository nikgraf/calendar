import { expandRecurringEvent } from '../recurrence/expand.ts';
import { occurrenceRecord, recurrenceMasterOf } from '../recurrence/window.ts';
import { toZonedDateTime } from '../time/convert.ts';
import type { EventRecord } from '../types.ts';
import { isNotOver } from './results.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Span = ReadonlyArray<EventRecord>;

/**
 * Expands from `fromUtc` towards `toUtc` (forward or back) span by span
 * until `pick` finds the answer in one. A span is tried whole first; one
 * the expander refuses — past EXPANSION_MAX_ITERATIONS — is retried a
 * quarter as long, down to an hour, where the error is the rule's own.
 */
const walk = (
  expand: (startUtc: number, endUtc: number) => Span,
  fromUtc: number,
  toUtc: number,
  pick: (span: Span) => EventRecord | undefined,
): EventRecord | undefined => {
  const forward = toUtc > fromUtc;
  let size = Math.abs(toUtc - fromUtc);
  let at = fromUtc;
  while (forward ? at < toUtc : at > toUtc) {
    const next = forward ? Math.min(toUtc, at + size) : Math.max(toUtc, at - size);
    let span: Span;
    try {
      span = forward ? expand(at, next) : expand(next, at);
    } catch (error) {
      if (size <= HOUR_MS) {
        throw error;
      }
      size = Math.ceil(size / 4);
      continue;
    }
    const found = pick(span);
    if (found) {
      return found;
    }
    at = next;
  }
  return undefined;
};

/**
 * What a matching series offers search inside [rangeStartUtc,
 * rangeEndUtc): its first occurrence that is not over, else its latest
 * one — the occurrence `buildSearchResults` would pick of all of them.
 * Slots an override took over (`slots`) are left out: the override rows
 * are matched on their own text.
 *
 * The series is walked outward from now — forward, then back only when
 * nothing is left ahead — instead of expanded over the whole window at
 * once, which an hourly series' thousands of occurrences would take past
 * the expander's iteration cap (`assembleWindow` then drops the series).
 * For most rules each direction is a single span. A rule that fails even
 * for an hour throws; the caller skips that series, as the views do.
 */
export const seriesSearchOccurrences = (
  master: EventRecord,
  slots: ReadonlySet<number> | undefined,
  {
    nowMs,
    rangeEndUtc,
    rangeStartUtc,
    timeZone,
  }: {
    readonly nowMs: number;
    readonly rangeEndUtc: number;
    readonly rangeStartUtc: number;
    readonly timeZone: string;
  },
): ReadonlyArray<EventRecord> => {
  if (!master.recurrence || master.recurrence.length === 0) {
    return [];
  }
  const rule = recurrenceMasterOf(master);
  const today = toZonedDateTime(nowMs, timeZone).toPlainDate().toString();
  const notOver = (occurrence: EventRecord) => isNotOver(occurrence, nowMs, today);
  const expand = (startUtc: number, endUtc: number): Span =>
    expandRecurringEvent(rule, startUtc, endUtc, slots).map((instance) =>
      occurrenceRecord(master, instance),
    );
  // Both walks start a day past now: today's all-day occurrence ends (in
  // UTC) before the evening in a zone behind UTC, and is still not over.
  const next = walk(expand, Math.max(rangeStartUtc, nowMs - DAY_MS), rangeEndUtc, (span) =>
    span.find(notOver),
  );
  if (next) {
    return [next];
  }
  const latest = walk(expand, Math.min(rangeEndUtc, nowMs + DAY_MS), rangeStartUtc, (span) =>
    span.filter((occurrence) => !notOver(occurrence)).at(-1),
  );
  return latest ? [latest] : [];
};
