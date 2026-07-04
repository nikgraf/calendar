import { Temporal } from '../time/temporal.ts';
import { expandRecurringEvent, type RecurrenceMaster } from './expand.ts';

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

const rewriteRule = (line: string, transform: (parts: Map<string, string>) => void): string => {
  const body = line.slice('RRULE:'.length);
  const parts = new Map<string, string>();
  for (const piece of body.split(';')) {
    const [key, value] = piece.split('=', 2);
    if (key && value !== undefined) {
      parts.set(key.toUpperCase(), value);
    }
  }
  transform(parts);
  return `RRULE:${[...parts.entries()].map(([key, value]) => `${key}=${value}`).join(';')}`;
};

/**
 * Truncates a recurrence so its last occurrence falls strictly before
 * `splitOriginalStartUtc` (UNTIL = split − 1s; any COUNT is dropped —
 * UNTIL and COUNT are mutually exclusive per RFC 5545).
 */
export const truncateRecurrence = (
  recurrence: ReadonlyArray<string>,
  splitOriginalStartUtc: number,
  isAllDay: boolean,
): Array<string> =>
  recurrence.map((line) =>
    line.toUpperCase().startsWith('RRULE:')
      ? rewriteRule(line, (parts) => {
          parts.delete('COUNT');
          parts.set(
            'UNTIL',
            isAllDay
              ? compactDate(splitOriginalStartUtc - 24 * 60 * 60 * 1000)
              : compactUtc(splitOriginalStartUtc - 1000),
          );
        })
      : line,
  );

/**
 * Recurrence lines for the new master created by a this-and-following split.
 * COUNT rules keep only the remaining occurrences (computed by expanding the
 * original master up to the split); UNTIL/unbounded rules carry over as-is.
 */
export const remainingRecurrence = (
  master: RecurrenceMaster,
  splitOriginalStartUtc: number,
): Array<string> =>
  master.recurrence.map((line) => {
    if (!line.toUpperCase().startsWith('RRULE:')) {
      return line;
    }
    return rewriteRule(line, (parts) => {
      const count = parts.get('COUNT');
      if (count !== undefined) {
        const consumed = expandRecurringEvent(
          master,
          master.startUtc,
          splitOriginalStartUtc,
        ).length;
        parts.set('COUNT', String(Math.max(Number(count) - consumed, 1)));
      }
    });
  });
