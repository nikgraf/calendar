import { toZonedDateTime } from '@calendar/core';

/**
 * EventKit's identifiers for the occurrences of a series (probed on the
 * iOS 27.2 simulator, local source — docs/google-sync-and-testing.md):
 *
 * - every occurrence the rule draws carries the series' `eventIdentifier`;
 * - an occurrence changed on its own (moved, renamed, any `thisEvent`
 *   save) gets one of its own, `<series id>/RID=<n>`, and
 *   `event(withIdentifier:)` answers it under that id wherever it sits.
 *
 * `n` is the slot in seconds since 2001 when the occurrence is detached —
 * for a floating or all-day event its wall clock read as UTC — and it is
 * never rewritten: after a series-wide time change the slot moves and `n`
 * stays. So the identifier says which series an occurrence belongs to,
 * never reliably which slot: the slot is `occurrenceStartUtc`, and an
 * identifier built from a slot is a guess to be checked against a read.
 */
const RID_SUFFIX = /\/RID=-?[\d.]+$/u;

/** Seconds from 1970 to 2001, EventKit's reference date. */
const REFERENCE_SECONDS = 978_307_200;

/** The series an EventKit event identifier belongs to: itself, or what precedes `/RID=`. */
export const appleSeriesId = (id: string): string => id.replace(RID_SUFFIX, '');

/** The `/RID=<n>` part of an occurrence's own identifier, or '' for a series identifier. */
export const appleRecurrenceSuffix = (id: string): string => RID_SUFFIX.exec(id)?.[0] ?? '';

/** The identifier EventKit gives an occurrence it detaches at this instant. */
export const appleDetachedId = (seriesId: string, instantUtc: number): string =>
  `${seriesId}/RID=${String(Math.round(instantUtc / 1000) - REFERENCE_SECONDS)}`;

/**
 * The identifiers the occurrence a series drew at `slot` may carry if it
 * was changed on its own: the slot as an instant, and as the wall clock
 * of `timeZone` (floating and all-day events). Either can be out of date,
 * and either can name a different occurrence by now — read before use.
 */
export const appleDetachedIdGuesses = (
  seriesId: string,
  slot: number,
  timeZone: string,
): ReadonlyArray<string> => {
  const wallClock = toZonedDateTime(slot, timeZone).toPlainDateTime().toZonedDateTime('UTC');
  const guesses = [
    appleDetachedId(seriesId, slot),
    appleDetachedId(seriesId, wallClock.epochMilliseconds),
  ];
  return guesses[0] === guesses[1] ? guesses.slice(0, 1) : guesses;
};
