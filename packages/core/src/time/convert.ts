import { Temporal } from './temporal.ts';

/** Milliseconds since the Unix epoch. The canonical instant type in stored data. */
export type EpochMs = number;

export const toZonedDateTime = (epochMs: EpochMs, timeZone: string): Temporal.ZonedDateTime =>
  Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);

export const toEpochMs = (zonedDateTime: Temporal.ZonedDateTime): EpochMs =>
  zonedDateTime.toInstant().epochMilliseconds;

/** UTC midnight of an ISO date ('2026-07-02'). Used to index all-day events. */
export const plainDateToUtcMs = (isoDate: string): EpochMs =>
  Temporal.PlainDate.from(isoDate).toZonedDateTime({ timeZone: 'UTC' }).toInstant()
    .epochMilliseconds;

export const utcMsToPlainDate = (epochMs: EpochMs): string =>
  Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO('UTC')
    .toPlainDate()
    .toString();

export const addDaysToPlainDate = (isoDate: string, days: number): string =>
  Temporal.PlainDate.from(isoDate).add({ days }).toString();

export const daysBetweenPlainDates = (fromIsoDate: string, untilIsoDate: string): number =>
  Temporal.PlainDate.from(fromIsoDate).until(Temporal.PlainDate.from(untilIsoDate)).days;
