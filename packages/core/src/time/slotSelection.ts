import { DRAG_SNAP_MINUTES } from './dragMath.ts';

const DAY_MINUTES = 24 * 60;

/** A range of one day's wall-clock minutes, drawn on the time grid. */
export interface SlotRange {
  /** Exclusive; up to 1440 (midnight at the end of the day). */
  readonly endMinute: number;
  readonly startMinute: number;
}

/**
 * Minutes from midnight at a vertical offset into a day column whose top is
 * midnight. Clamped to the day.
 */
export const minuteOfDay = (offsetY: number, hourHeight: number): number => {
  // Callable from a reanimated gesture callback on the UI thread (iOS);
  // inert everywhere else.
  'worklet';
  const minutes = (offsetY / hourHeight) * 60;
  return Math.min(Math.max(minutes, 0), DAY_MINUTES);
};

/**
 * The slot a drag from `anchorMinute` to `currentMinute` selects, snapped to
 * `step`. The quarter the gesture started in is always part of the slot:
 * dragging down extends the end to the next boundary at or past the
 * pointer, dragging up moves the start to the boundary at or before it
 * (press 10:07 and drag to 11:20 → 10:00–11:30; drag to 09:40 →
 * 09:30–10:15). Never shorter than one step, never outside the day.
 */
export const slotFromDrag = (
  anchorMinute: number,
  currentMinute: number,
  step: number = DRAG_SNAP_MINUTES,
): SlotRange => {
  'worklet';
  const lastStart = DAY_MINUTES - step;
  const anchorStart = Math.min(Math.max(Math.floor(anchorMinute / step) * step, 0), lastStart);
  const pointerStart = Math.min(Math.max(Math.floor(currentMinute / step) * step, 0), lastStart);
  const pointerEnd = Math.min(Math.max(Math.ceil(currentMinute / step) * step, step), DAY_MINUTES);
  return {
    endMinute: Math.max(anchorStart + step, pointerEnd),
    startMinute: Math.min(anchorStart, pointerStart),
  };
};

const clock = (minute: number): string => {
  'worklet';
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${hours < 10 ? '0' : ''}${hours}:${minutes < 10 ? '0' : ''}${minutes}`;
};

/**
 * A slot as the editor's `HH:MM` fields. A slot ending at midnight ends at
 * 23:59: events are same-day in the editor, and `24:00` is not a valid
 * time for it.
 */
export const slotTimes = (slot: SlotRange): { endTime: string; startTime: string } => {
  'worklet';
  return {
    endTime: slot.endMinute >= DAY_MINUTES ? '23:59' : clock(slot.endMinute),
    startTime: clock(slot.startMinute),
  };
};
