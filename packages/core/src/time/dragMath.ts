import type { EpochMs } from './convert.ts';
import { Temporal } from './temporal.ts';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const DRAG_SNAP_MINUTES = 15;
const MIN_DURATION_MS = DRAG_SNAP_MINUTES * MINUTE_MS;

export const snapMinutes = (minutes: number, step = DRAG_SNAP_MINUTES): number =>
  Math.round(minutes / step) * step;

export interface EventTimes {
  readonly endUtc: EpochMs;
  /** IANA zone used for wall-clock day shifts; instant math when omitted. */
  readonly startTimeZone?: string | undefined;
  readonly startUtc: EpochMs;
}

const shiftWallClock = (
  epochMs: EpochMs,
  timeZone: string,
  days: number,
  minutes: number,
): EpochMs =>
  Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .add({ days, minutes })
    .toZonedDateTime(timeZone).epochMilliseconds;

/**
 * Shifts an event by a (snapped) minute delta plus whole days, preserving its
 * absolute duration. The shift is wall-clock arithmetic in the event's zone:
 * dragging a 09:00 event one day across a DST change keeps it at 09:00.
 */
export const moveEventTimes = (
  event: EventTimes,
  deltaMinutes: number,
  deltaDays = 0,
): Pick<EventTimes, 'endUtc' | 'startUtc'> => {
  const minutes = snapMinutes(deltaMinutes);
  if (!event.startTimeZone) {
    const shiftMs = minutes * MINUTE_MS + deltaDays * DAY_MS;
    return { endUtc: event.endUtc + shiftMs, startUtc: event.startUtc + shiftMs };
  }
  const startUtc = shiftWallClock(event.startUtc, event.startTimeZone, deltaDays, minutes);
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
  return shiftWallClock(baseUtc, timeZone, days, minutes);
};

/**
 * Adjusts only the end by a (snapped) minute delta, clamped so the event
 * keeps at least one snap step of duration.
 */
export const resizeEventEnd = (
  event: EventTimes,
  deltaMinutes: number,
): Pick<EventTimes, 'endUtc'> => {
  const shifted = event.endUtc + snapMinutes(deltaMinutes) * MINUTE_MS;
  return {
    endUtc: Math.max(shifted, event.startUtc + MIN_DURATION_MS),
  };
};
