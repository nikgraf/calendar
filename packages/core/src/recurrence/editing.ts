import { plainDateToUtcMs } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';
import {
  DTSTART_ONLY_RULE,
  expandRecurringEvent,
  type RecurrenceMaster,
  ruleOccurrenceNear,
  ruleOccurrencesBefore,
} from './expand.ts';

/**
 * Helpers for editing recurring series the way Google Calendar does it:
 * single instances become exception events with the canonical instance id;
 * "this and following" splits the series by truncating the old master with
 * UNTIL and starting a new master at the edited occurrence.
 */

/** Compact UTC basetime Google uses in instance ids and UNTIL values. */
export const compactUtc = (epochMs: number): string =>
  Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO('UTC')
    .toPlainDateTime()
    .toString({ fractionalSecondDigits: 0 })
    .replaceAll(/[:-]/g, '') + 'Z';

const compactDate = (epochMs: number): string =>
  Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO('UTC')
    .toPlainDate()
    .toString()
    .replaceAll('-', '');

/**
 * The id Google assigns to an occurrence of a recurring event — also the id
 * its exception event gets when the occurrence is modified. Using it locally
 * keeps our override rows identical to what sync later pulls back.
 */
export const googleInstanceId = (
  masterId: string,
  originalStartUtc: number,
  isAllDay: boolean,
): string =>
  `${masterId}_${isAllDay ? compactDate(originalStartUtc) : compactUtc(originalStartUtc)}`;

/** `RRULE:FREQ=WEEKLY;COUNT=10` → Map { FREQ → WEEKLY, COUNT → 10 } (keys upper-cased). */
export const parseRuleParts = (line: string): Map<string, string> => {
  const body = line.slice('RRULE:'.length);
  const parts = new Map<string, string>();
  for (const piece of body.split(';')) {
    const [key, value] = piece.split('=', 2);
    if (key && value !== undefined) {
      parts.set(key.toUpperCase(), value);
    }
  }
  return parts;
};

const rewriteRule = (line: string, transform: (parts: Map<string, string>) => void): string => {
  const parts = parseRuleParts(line);
  transform(parts);
  return `RRULE:${[...parts.entries()].map(([key, value]) => `${key}=${value}`).join(';')}`;
};

/**
 * Epoch ms of one RDATE/EXDATE value. Forms: `20260714T090000Z` (UTC),
 * `20260714T090000` (wall clock in `TZID=` or, floating, the series
 * zone), `20260714` (`VALUE=DATE`), and a PERIOD's `start/end` (start
 * counts). Undefined when it does not parse — such a value is kept, never
 * silently dropped.
 */
const listValueMs = (
  value: string,
  params: ReadonlyMap<string, string>,
  seriesTimeZone: string,
): number | undefined => {
  const raw = value.split('/')[0] ?? '';
  try {
    if (params.get('VALUE') === 'DATE' || /^\d{8}$/.test(raw)) {
      return plainDateToUtcMs(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
    }
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(raw);
    if (!match) {
      return undefined;
    }
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
    if (match[7] === 'Z') {
      return Temporal.Instant.from(`${iso}Z`).epochMilliseconds;
    }
    const zone = params.get('TZID') ?? seriesTimeZone;
    return Temporal.PlainDateTime.from(iso).toZonedDateTime(zone).epochMilliseconds;
  } catch {
    return undefined;
  }
};

/** `RDATE;TZID=…;VALUE=…:v1,v2` → params + values (the property name is not included). */
const parseDateList = (
  line: string,
): { readonly params: Map<string, string>; readonly values: Array<string> } => {
  const colon = line.indexOf(':');
  const head = colon === -1 ? line : line.slice(0, colon);
  const values = colon === -1 ? [] : line.slice(colon + 1).split(',');
  const params = new Map<string, string>();
  for (const piece of head.split(';').slice(1)) {
    const [key, value] = piece.split('=', 2);
    if (key && value !== undefined) {
      params.set(key.toUpperCase(), value);
    }
  }
  return { params, values };
};

/** A date-time UNTIL (`20260704T085959Z`) as epoch ms, or undefined for any other form. */
const utcUntil = (value: string | undefined): number | undefined => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value ?? '');
  return match
    ? Temporal.Instant.from(
        `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`,
      ).epochMilliseconds
    : undefined;
};

/** Rule parts that fix the clock time of the occurrences, whatever DTSTART says. */
const CLOCK_PARTS = ['BYHOUR', 'BYMINUTE', 'BYSECOND'] as const;

/**
 * The recurrence of a timed series moved as a whole: `series` as it is,
 * its first occurrence moving to `movedStartUtc` and every occurrence as
 * `move` says (a series edit's or a split's wall-clock delta). A date-time
 * UNTIL bounds instants, and is read against the occurrences, not the
 * move: when the last occurrence, moved, still falls under the bound but
 * the next one would now fall under it too — an earlier time of day, so a
 * cut's `UNTIL = split − 1s` drew the split day twice — the bound moves to
 * just before that next one. Otherwise it stays: a later time of day keeps
 * the next occurrence past it, and a last occurrence moved past it (a move
 * by days, past an end date) is left out, so a cut stays before its split
 * and "Ends Dec 31" stays Dec 31. Round trips and a zone's midnight change
 * nothing it reads. A rule whose BYHOUR/BYMINUTE/BYSECOND fix its times,
 * a date-only UNTIL, COUNT and the RDATE/EXDATE lines stay as they are.
 */
export const retimedRecurrence = (
  series: RecurrenceMaster,
  movedStartUtc: number,
  move: (epochMs: number) => number,
): Array<string> =>
  series.recurrence.map((line) => {
    if (series.isAllDay || !line.toUpperCase().startsWith('RRULE:')) {
      return line;
    }
    const parts = parseRuleParts(line);
    const until = utcUntil(parts.get('UNTIL'));
    if (until === undefined || CLOCK_PARTS.some((part) => parts.has(part))) {
      return line;
    }
    const open = rewriteRule(line, (rule) => {
      rule.delete('UNTIL');
    });
    const last = ruleOccurrenceNear(series, open, until, 'previous');
    if (last === undefined || move(last) > until) {
      return line;
    }
    const next = ruleOccurrenceNear(
      { ...series, startUtc: movedStartUtc },
      open,
      move(last),
      'next',
    );
    return next === undefined || next > until
      ? line
      : rewriteRule(line, (rule) => {
          rule.set('UNTIL', compactUtc(next - 1000));
        });
  });

/**
 * Truncates a recurrence so its last occurrence falls strictly before
 * `splitOriginalStartUtc` (UNTIL = split − 1s; any COUNT is dropped —
 * UNTIL and COUNT are mutually exclusive per RFC 5545). RDATE lines are
 * pruned the same way: UNTIL only bounds the RRULE, so an explicit
 * occurrence at or after the split would otherwise survive in the old
 * series. EXDATE lines stay as they are (an exclusion past the split is
 * harmless). A set of only RDATE lines with no value left before the split
 * keeps DTSTART alone through DTSTART_ONLY_RULE: the old master stays a
 * series for its exceptions, and the update is a PATCH, where an absent
 * recurrence would keep the old one on Google.
 */
export const truncateRecurrence = (
  recurrence: ReadonlyArray<string>,
  splitOriginalStartUtc: number,
  isAllDay: boolean,
  seriesTimeZone = 'UTC',
): Array<string> => {
  const truncated = pruneForTruncation(recurrence, splitOriginalStartUtc, isAllDay, seriesTimeZone);
  return isRecurringSet(truncated) ? truncated : [DTSTART_ONLY_RULE, ...truncated];
};

const pruneForTruncation = (
  recurrence: ReadonlyArray<string>,
  splitOriginalStartUtc: number,
  isAllDay: boolean,
  seriesTimeZone: string,
): Array<string> =>
  recurrence.flatMap((line) => {
    const upper = line.toUpperCase();
    if (upper.startsWith('RRULE:')) {
      return [
        rewriteRule(line, (parts) => {
          parts.delete('COUNT');
          parts.set(
            'UNTIL',
            isAllDay
              ? compactDate(splitOriginalStartUtc - 24 * 60 * 60 * 1000)
              : compactUtc(splitOriginalStartUtc - 1000),
          );
        }),
      ];
    }
    if (upper.startsWith('RDATE')) {
      const { params, values } = parseDateList(line);
      const kept = values.filter((value) => {
        const ms = listValueMs(value, params, seriesTimeZone);
        return ms === undefined || ms < splitOriginalStartUtc;
      });
      if (kept.length === 0) {
        return [];
      }
      const colon = line.indexOf(':');
      return [`${line.slice(0, colon + 1)}${kept.join(',')}`];
    }
    return [line];
  });

/**
 * A split can reanchor each RRULE only at an occurrence that rule generates.
 * An extra date could change its interval, implicit weekday or wall time.
 * Conservatively refuse such splits even when a particular BYDAY rule would
 * survive; sets of only RDATE lines have no phase to lose. Check each rule
 * alone, without the set's additions or exclusions.
 */
export const canSplitRecurrence = (
  master: RecurrenceMaster,
  splitOriginalStartUtc: number,
): boolean =>
  master.recurrence
    .filter((line) => line.toUpperCase().startsWith('RRULE:'))
    .every((line) =>
      expandRecurringEvent(
        { ...master, recurrence: [line] },
        // Include the start even for a zero-duration event: membership
        // does not depend on whether an event overlaps a visible window.
        splitOriginalStartUtc - 1,
        splitOriginalStartUtc + 1,
      ).some((occurrence) => occurrence.originalStartUtc === splitOriginalStartUtc),
    );

/**
 * Recurrence lines for the new master created by a this-and-following split.
 * Callers must first pass canSplitRecurrence before using these lines to
 * reanchor the original schedule at a later DTSTART.
 * COUNT rules keep only the remaining occurrences: COUNT counts what the
 * rule generates before any exclusion (RFC 5545), so the consumed part is
 * the RRULE alone expanded up to the split — RDATE values add to it and
 * EXDATE values do not take from it. UNTIL/unbounded rules carry over
 * as-is. RDATE values keep only those after the split (rrule-temporal emits
 * values before DTSTART too, so the old series' would show twice). The
 * value at the split is the occurrence being edited: it becomes the new
 * master's DTSTART, which is always an occurrence (on Google, and here via
 * `buildRuleString`) even on a day the rule skips. A line left empty is
 * dropped. EXDATE lines stay (an exclusion before the new start is
 * harmless).
 */
export const remainingRecurrence = (
  master: RecurrenceMaster,
  splitOriginalStartUtc: number,
): Array<string> =>
  master.recurrence.flatMap((line) => {
    const upper = line.toUpperCase();
    if (upper.startsWith('RDATE')) {
      const { params, values } = parseDateList(line);
      const kept = values.filter((value) => {
        const ms = listValueMs(value, params, master.startTimeZone);
        return ms === undefined || ms > splitOriginalStartUtc;
      });
      if (kept.length === 0) {
        return [];
      }
      const colon = line.indexOf(':');
      return [`${line.slice(0, colon + 1)}${kept.join(',')}`];
    }
    if (!upper.startsWith('RRULE:')) {
      return [line];
    }
    return [
      rewriteRule(line, (parts) => {
        const count = parts.get('COUNT');
        if (count !== undefined) {
          const consumed = ruleOccurrencesBefore(master, line, splitOriginalStartUtc);
          parts.set('COUNT', String(Math.max(Number(count) - consumed, 1)));
        }
      }),
    ];
  });

/**
 * Whether lines still describe a series: an RRULE or an RDATE value. The
 * new half of a split of a set of only RDATE lines can be left with
 * neither (just DTSTART, maybe EXDATEs) — it is created as a single event.
 */
export const isRecurringSet = (recurrence: ReadonlyArray<string>): boolean =>
  recurrence.some((line) => {
    const upper = line.toUpperCase();
    return upper.startsWith('RRULE:') || upper.startsWith('RDATE');
  });
