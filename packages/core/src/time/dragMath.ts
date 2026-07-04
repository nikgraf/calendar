import type { EpochMs } from './convert.ts';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const DRAG_SNAP_MINUTES = 15;
const MIN_DURATION_MS = DRAG_SNAP_MINUTES * MINUTE_MS;

export const snapMinutes = (minutes: number, step = DRAG_SNAP_MINUTES): number =>
  Math.round(minutes / step) * step;

export interface EventTimes {
  readonly endUtc: EpochMs;
  readonly startUtc: EpochMs;
}

/**
 * Shifts an event by a (snapped) minute delta plus whole days, preserving its
 * absolute duration — matching how Google patches dateTime fields. Note this
 * is an instant shift: dragging across a DST change keeps the duration, so
 * the wall-clock time can differ by the offset change.
 */
export const moveEventTimes = (
  event: EventTimes,
  deltaMinutes: number,
  deltaDays = 0,
): EventTimes => {
  const shiftMs = snapMinutes(deltaMinutes) * MINUTE_MS + deltaDays * DAY_MS;
  return {
    endUtc: event.endUtc + shiftMs,
    startUtc: event.startUtc + shiftMs,
  };
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
