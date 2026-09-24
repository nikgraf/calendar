import { DRAG_SNAP_MINUTES } from './dragMath.ts';

const DAY_MINUTES = 24 * 60;

// These are worklets: on iOS they run on the UI runtime, where a captured
// module constant only exists inside the function body. A default
// parameter is evaluated before the body, so `step = DRAG_SNAP_MINUTES`
// would throw a ReferenceError there and crash the app. Resolve such
// defaults in the body instead.

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
  stepMinutes?: number,
): SlotRange => {
  'worklet';
  const step = stepMinutes ?? DRAG_SNAP_MINUTES;
  const lastStart = DAY_MINUTES - step;
  const anchorStart = Math.min(Math.max(Math.floor(anchorMinute / step) * step, 0), lastStart);
  const pointerStart = Math.min(Math.max(Math.floor(currentMinute / step) * step, 0), lastStart);
  const pointerEnd = Math.min(Math.max(Math.ceil(currentMinute / step) * step, step), DAY_MINUTES);
  return {
    endMinute: Math.max(anchorStart + step, pointerEnd),
    startMinute: Math.min(anchorStart, pointerStart),
  };
};

/**
 * The slot a press-and-hold selects on a touch screen. Holding shows a
 * `defaultMinutes` slot from the quarter the finger touched down in (Apple
 * Calendar's one-hour default); dragging while still holding only ever
 * grows it: down past that slot's end moves the end to the finger, and a
 * finger at least one `step` above the touch-down point moves the start to
 * it. Nothing smaller than that changes the slot, so the few points a
 * finger drifts during a hold (a minute is about one point on the phone)
 * can neither shorten the default nor shift it by a quarter.
 */
export const slotFromHold = (
  anchorMinute: number,
  currentMinute: number,
  stepMinutes?: number,
  defaultMinutes = 60,
): SlotRange => {
  'worklet';
  const step = stepMinutes ?? DRAG_SNAP_MINUTES;
  const lastStart = DAY_MINUTES - step;
  const anchorStart = Math.min(Math.max(Math.floor(anchorMinute / step) * step, 0), lastStart);
  const defaultEnd = Math.min(anchorStart + defaultMinutes, DAY_MINUTES);
  const pointerEnd = Math.min(Math.ceil(currentMinute / step) * step, DAY_MINUTES);
  const pointerStart = Math.max(Math.floor(currentMinute / step) * step, 0);
  return {
    endMinute: Math.max(defaultEnd, pointerEnd),
    startMinute:
      currentMinute <= anchorMinute - step ? Math.min(anchorStart, pointerStart) : anchorStart,
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
