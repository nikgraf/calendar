import type { FreeSlot } from './findSlots.ts';

const minuteOf = (time: string): number => {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return hour * 60 + minute;
};

/** Slots this close to the centre count the same: a quarter hour either way is no better slot. */
const BAND_MINUTES = 30;

/**
 * Free slots ordered for a named time of day ("mornings", "lunch"): the
 * nearer a slot's middle lies to the centre the better, with slots
 * within half an hour of each other counting the same, and among equals
 * the sooner first. Without a centre the order stays the solver's own:
 * chronological.
 */
export const rankSlotsAround = (
  slots: ReadonlyArray<FreeSlot>,
  centreTime: string | undefined,
): ReadonlyArray<FreeSlot> => {
  if (centreTime === undefined) {
    return slots;
  }
  const centre = minuteOf(centreTime);
  const band = (slot: FreeSlot): number =>
    Math.floor(
      Math.abs((minuteOf(slot.startTime) + minuteOf(slot.endTime)) / 2 - centre) / BAND_MINUTES,
    );
  return slots
    .map((slot, index) => ({ index, slot }))
    .sort((left, right) => band(left.slot) - band(right.slot) || left.index - right.index)
    .map(({ slot }) => slot);
};
