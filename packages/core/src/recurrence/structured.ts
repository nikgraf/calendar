import { Schema } from 'effect';
import { Temporal } from '../time/temporal.ts';
import { ByDay, formatByDay, WEEKDAY_CODES, type Weekday } from './byDay.ts';
import { compactUtc, parseRuleParts } from './editing.ts';

/**
 * RFC 5545 recurrence text ↔ the structured subset EventKit can store
 * (`EKRecurrenceRule`). Apple calendars speak this shape over the bridge
 * so the Swift side never parses RRULE text; the conversion lives here,
 * where it is unit-tested.
 *
 * EventKit has no EXDATE/RDATE/EXRULE lines (a deleted occurrence is a
 * detached exception, not rule text), no BYHOUR/BYMINUTE/BYSECOND, and
 * always starts weeks on the calendar's first weekday. Rules using any of
 * those come back in `unsupported` and are never written.
 */

export const StructuredRule = Schema.Struct({
  /** BYDAY entries; `ordinal` is the week number (1…53, -1 = last) for monthly/yearly rules. */
  byDay: Schema.optional(Schema.Array(ByDay)),
  byMonth: Schema.optional(Schema.Array(Schema.Number)),
  byMonthDay: Schema.optional(Schema.Array(Schema.Number)),
  bySetPos: Schema.optional(Schema.Array(Schema.Number)),
  byWeekNo: Schema.optional(Schema.Array(Schema.Number)),
  byYearDay: Schema.optional(Schema.Array(Schema.Number)),
  count: Schema.optional(Schema.Number),
  freq: Schema.Literals(['daily', 'monthly', 'weekly', 'yearly']),
  interval: Schema.Number,
  /** All-day series: inclusive last day, 'YYYY-MM-DD'. */
  untilDate: Schema.optional(Schema.String),
  /** Timed series: the last occurrence may start at or before this instant. */
  untilUtc: Schema.optional(Schema.Number),
});
export type StructuredRule = typeof StructuredRule.Type;

const FREQS = new Set(['DAILY', 'MONTHLY', 'WEEKLY', 'YEARLY']);
type ListField = 'byMonth' | 'byMonthDay' | 'bySetPos' | 'byWeekNo' | 'byYearDay';
const LIST_PARTS: ReadonlyArray<readonly [string, ListField]> = [
  ['BYMONTH', 'byMonth'],
  ['BYMONTHDAY', 'byMonthDay'],
  ['BYSETPOS', 'bySetPos'],
  ['BYWEEKNO', 'byWeekNo'],
  ['BYYEARDAY', 'byYearDay'],
];
const KNOWN_PARTS = new Set([
  'BYDAY',
  'COUNT',
  'FREQ',
  'INTERVAL',
  'UNTIL',
  'WKST',
  ...LIST_PARTS.map(([part]) => part),
]);

const numberList = (value: string): Array<number> | undefined => {
  const numbers = value.split(',').map(Number);
  return numbers.every((n) => Number.isInteger(n) && n !== 0) ? numbers : undefined;
};

/** `20260714`, `20260714T090000Z` or floating `20260714T090000` (read in `timeZone`). */
const parseUntil = (
  value: string,
  isAllDay: boolean,
  timeZone: string,
): Pick<StructuredRule, 'untilDate' | 'untilUtc'> | undefined => {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value);
  if (!match) {
    return undefined;
  }
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  try {
    if (isAllDay) {
      return { untilDate: Temporal.PlainDate.from(date).toString() };
    }
    if (match[4] === undefined) {
      // A date-only UNTIL on a timed series: the whole day counts.
      return {
        untilUtc: Temporal.PlainDate.from(date)
          .toZonedDateTime({ plainTime: '23:59:59', timeZone })
          .toInstant().epochMilliseconds,
      };
    }
    const iso = `${date}T${match[4]}:${match[5]}:${match[6]}`;
    return {
      untilUtc:
        match[7] === 'Z'
          ? Temporal.Instant.from(`${iso}Z`).epochMilliseconds
          : Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds,
    };
  } catch {
    return undefined;
  }
};

/**
 * Converts recurrence lines to EventKit's structured rules. Every line or
 * rule part EventKit cannot store is named in `unsupported` (e.g. "EXDATE",
 * "BYHOUR"); callers refuse the write when it is non-empty.
 */
export const toStructuredRules = (
  lines: ReadonlyArray<string>,
  isAllDay: boolean,
  timeZone = 'UTC',
): { readonly rules: Array<StructuredRule>; readonly unsupported: Array<string> } => {
  const rules: Array<StructuredRule> = [];
  const unsupported = new Set<string>();
  for (const line of lines) {
    const name = (/^[A-Za-z-]+/.exec(line)?.[0] ?? line).toUpperCase();
    if (name !== 'RRULE') {
      unsupported.add(name);
      continue;
    }
    const parts = parseRuleParts(line);
    const lineUnsupported: Array<string> = [];
    for (const key of parts.keys()) {
      if (!KNOWN_PARTS.has(key)) {
        lineUnsupported.push(key);
      }
    }
    const freq = parts.get('FREQ')?.toUpperCase();
    if (!freq || !FREQS.has(freq)) {
      lineUnsupported.push(`FREQ=${freq ?? ''}`);
    }
    const wkst = parts.get('WKST');
    if (wkst !== undefined && wkst.toUpperCase() !== 'MO') {
      lineUnsupported.push('WKST');
    }
    if (parts.has('COUNT') && parts.has('UNTIL')) {
      lineUnsupported.push('COUNT+UNTIL');
    }
    const interval = parts.has('INTERVAL') ? Number(parts.get('INTERVAL')) : 1;
    if (!Number.isInteger(interval) || interval < 1) {
      lineUnsupported.push('INTERVAL');
    }
    const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : undefined;
    if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
      lineUnsupported.push('COUNT');
    }
    const until = parts.has('UNTIL')
      ? parseUntil(parts.get('UNTIL') ?? '', isAllDay, timeZone)
      : {};
    if (until === undefined) {
      lineUnsupported.push('UNTIL');
    }
    let byDay: Array<{ ordinal?: number; weekday: Weekday }> | undefined;
    const byDayRaw = parts.get('BYDAY');
    if (byDayRaw !== undefined) {
      byDay = [];
      for (const piece of byDayRaw.split(',')) {
        const match = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(piece.toUpperCase());
        const weekday = match?.[2];
        if (!match || !weekday || !WEEKDAY_CODES.has(weekday)) {
          lineUnsupported.push('BYDAY');
          break;
        }
        const ordinal = match[1] === undefined ? undefined : Number(match[1]);
        byDay.push({
          ...(ordinal === undefined ? {} : { ordinal }),
          weekday: weekday as Weekday,
        });
      }
    }
    const lists: Partial<Record<ListField, Array<number>>> = {};
    for (const [part, field] of LIST_PARTS) {
      const raw = parts.get(part);
      if (raw === undefined) {
        continue;
      }
      const numbers = numberList(raw);
      if (numbers) {
        lists[field] = numbers;
      } else {
        lineUnsupported.push(part);
      }
    }
    if (lineUnsupported.length > 0) {
      for (const part of lineUnsupported) {
        unsupported.add(part);
      }
      continue;
    }
    rules.push({
      ...(byDay ? { byDay } : {}),
      ...lists,
      ...(count === undefined ? {} : { count }),
      freq: (freq ?? 'DAILY').toLowerCase() as StructuredRule['freq'],
      interval,
      ...until,
    });
  }
  return { rules, unsupported: [...unsupported].sort() };
};

/** The recurrence parts a series would lose on an Apple calendar (empty = none). */
export const unsupportedRuleParts = (
  lines: ReadonlyArray<string> | undefined,
  isAllDay: boolean,
): Array<string> => (lines ? toStructuredRules(lines, isAllDay).unsupported : []);

/** Structured rules back to RRULE lines (never DTSTART — it derives from the event start). */
export const toRRuleLines = (
  rules: ReadonlyArray<StructuredRule>,
  isAllDay: boolean,
): Array<string> =>
  rules.map((rule) => {
    const parts = [`FREQ=${rule.freq.toUpperCase()}`];
    if (rule.interval > 1) {
      parts.push(`INTERVAL=${rule.interval}`);
    }
    if (rule.count !== undefined) {
      parts.push(`COUNT=${rule.count}`);
    } else if (rule.untilDate !== undefined) {
      const compact = rule.untilDate.replaceAll('-', '');
      parts.push(`UNTIL=${isAllDay ? compact : `${compact}T235959Z`}`);
    } else if (rule.untilUtc !== undefined) {
      parts.push(
        `UNTIL=${
          isAllDay
            ? Temporal.Instant.fromEpochMilliseconds(rule.untilUtc)
                .toZonedDateTimeISO('UTC')
                .toPlainDate()
                .toString()
                .replaceAll('-', '')
            : compactUtc(rule.untilUtc)
        }`,
      );
    }
    if (rule.byDay && rule.byDay.length > 0) {
      parts.push(`BYDAY=${formatByDay(rule.byDay)}`);
    }
    for (const [part, field] of LIST_PARTS) {
      const values = rule[field];
      if (values && values.length > 0) {
        parts.push(`${part}=${values.join(',')}`);
      }
    }
    return `RRULE:${parts.join(';')}`;
  });
