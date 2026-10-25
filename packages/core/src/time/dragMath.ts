import type { EpochMs } from './convert.ts';
import { Temporal } from './temporal.ts';

const MINUTE_MS = 60 * 1000;
export const DRAG_SNAP_MINUTES = 15;
const MIN_DURATION_MS = DRAG_SNAP_MINUTES * MINUTE_MS;

export const snapMinutes = (minutes: number, step = DRAG_SNAP_MINUTES): number =>
  Math.round(minutes / step) * step;

export interface EventTimes {
  readonly endUtc: EpochMs;
  readonly startUtc: EpochMs;
}

const shiftWallClock = (
  epochMs: EpochMs,
  timeZone: string,
  days: number,
  minutes: number,
  offset?: string,
): EpochMs => {
  const from = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
  // Apart: one duration cannot mix signs (a day right, an hour up).
  const to = from.toPlainDateTime().add({ days }).add({ minutes });
  // `with` keeps an offset (`from`'s unless one is named) while it is valid
  // at the new wall clock, so the second 02:30 of a fall-back night moves on
  // from the second one.
  return from.with({
    day: to.day,
    hour: to.hour,
    minute: to.minute,
    month: to.month,
    offset: offset ?? from.offset,
    year: to.year,
  }).epochMilliseconds;
};

/**
 * Shifts an event by a (snapped) minute delta plus whole days, preserving its
 * absolute duration. The shift is wall-clock arithmetic in `timeZone`, the
 * zone the grid draws in, so the event lands on the row it was dropped on:
 * a 09:00 block dragged one day across a DST change stays at 09:00, whatever
 * zone the event itself is in.
 */
export const moveEventTimes = (
  event: EventTimes,
  timeZone: string,
  deltaMinutes: number,
  deltaDays = 0,
): Pick<EventTimes, 'endUtc' | 'startUtc'> => {
  const startUtc = shiftWallClock(event.startUtc, timeZone, deltaDays, snapMinutes(deltaMinutes));
  return { endUtc: startUtc + (event.endUtc - event.startUtc), startUtc };
};

/**
 * Applies the wall-clock difference between two instants (in `timeZone`) to
 * a third one — used to shift a whole series by the delta the user applied
 * to one occurrence, without picking up DST offset differences between the
 * occurrence's date and the series start.
 */
export const applyWallClockDelta = (
  baseUtc: EpochMs,
  timeZone: string,
  fromUtc: EpochMs,
  toUtc: EpochMs,
): EpochMs => {
  const from = Temporal.Instant.fromEpochMilliseconds(fromUtc).toZonedDateTimeISO(timeZone);
  const to = Temporal.Instant.fromEpochMilliseconds(toUtc).toZonedDateTimeISO(timeZone);
  const days = from.toPlainDate().until(to.toPlainDate()).total({ unit: 'days' });
  const minutes =
    to.hour * 60 + to.minute + to.second / 60 - (from.hour * 60 + from.minute + from.second / 60);
  // The pass of a repeated hour the occurrence was moved into, not the base's.
  return shiftWallClock(baseUtc, timeZone, days, minutes, to.offset);
};

/**
 * Adjusts only the end by a (snapped) minute delta, wall clock in `timeZone`
 * like a move, clamped so the event keeps at least one snap step of duration.
 */
export const resizeEventEnd = (
  event: EventTimes,
  timeZone: string,
  deltaMinutes: number,
): Pick<EventTimes, 'endUtc'> => ({
  endUtc: Math.max(
    shiftWallClock(event.endUtc, timeZone, 0, snapMinutes(deltaMinutes)),
    event.startUtc + MIN_DURATION_MS,
  ),
});
