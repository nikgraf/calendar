import type { EpochMs } from './convert.ts';
import { Temporal } from './temporal.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  deltas: ReadonlyArray<Temporal.DurationLike>,
  offset?: string,
): EpochMs => {
  const from = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
  // Apart: one duration cannot mix signs (a day right, an hour up).
  const to = deltas.reduce<Temporal.PlainDateTime>(
    (wall, delta) => wall.add(delta),
    from.toPlainDateTime(),
  );
  // `with` keeps an offset (`from`'s unless one is named) while it is valid
  // at the new wall clock, so the second 02:30 of a fall-back night moves on
  // from the second one.
  return from.with({
    day: to.day,
    hour: to.hour,
    millisecond: to.millisecond,
    minute: to.minute,
    month: to.month,
    offset: offset ?? from.offset,
    second: to.second,
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
  const startUtc = shiftWallClock(event.startUtc, timeZone, [
    { days: deltaDays },
    { minutes: snapMinutes(deltaMinutes) },
  ]);
  return { endUtc: startUtc + (event.endUtc - event.startUtc), startUtc };
};

/**
 * Applies the wall-clock difference between two instants (in `timeZone`) to
 * a third one — used to shift a whole series by the delta the user applied
 * to one occurrence, without picking up DST offset differences between the
 * occurrence's date and the series start. The delta is exact, seconds
 * included: a series starting at 09:00:30 retimed to 10:00 starts at 10:00.
 */
export const applyWallClockDelta = (
  baseUtc: EpochMs,
  timeZone: string,
  fromUtc: EpochMs,
  toUtc: EpochMs,
): EpochMs => {
  const from = Temporal.Instant.fromEpochMilliseconds(fromUtc).toZonedDateTimeISO(timeZone);
  const to = Temporal.Instant.fromEpochMilliseconds(toUtc).toZonedDateTimeISO(timeZone);
  // One sign throughout: `until` balances a day later and 30 s earlier into
  // 23:59:30, which wall-clock arithmetic adds back the same.
  const delta = from.toPlainDateTime().until(to.toPlainDateTime());
  // The pass of a repeated hour the occurrence was moved into, not the base's.
  return shiftWallClock(baseUtc, timeZone, [delta], to.offset);
};

/**
 * `applyWallClockDelta` without the delta's whole days: the wall-clock
 * change between two instants (in `timeZone`), split at the nearest whole
 * day, applied to a third by its time part alone (within ±12 hours). An
 * hour earlier stays an hour earlier where it crosses the zone's midnight
 * (00:30 → 23:30 the evening before), and a move by a day moves nothing.
 */
export const applyTimeOfDayDelta = (
  baseUtc: EpochMs,
  timeZone: string,
  fromUtc: EpochMs,
  toUtc: EpochMs,
): EpochMs => {
  const wall = (utc: EpochMs) =>
    Temporal.Instant.fromEpochMilliseconds(utc).toZonedDateTimeISO(timeZone).toPlainDateTime();
  const delta = wall(fromUtc)
    .until(wall(toUtc), { largestUnit: 'hours' })
    .total({ unit: 'milliseconds' });
  const timeOfDay = delta - Math.round(delta / DAY_MS) * DAY_MS;
  return wall(baseUtc).add({ milliseconds: timeOfDay }).toZonedDateTime(timeZone).epochMilliseconds;
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
    shiftWallClock(event.endUtc, timeZone, [{ minutes: snapMinutes(deltaMinutes) }]),
    event.startUtc + MIN_DURATION_MS,
  ),
});
