import type { FreeSlot } from './scheduling/findSlots.ts';
import { Temporal } from './time/temporal.ts';

/**
 * What an event without a title is called on screen. Both mappers put it
 * in the record (the editors require a title, so an untitled event stays
 * editable), and neither write path sends it: Google gets an empty title,
 * EventKit none. Sent back, it named the event "(no title)" for every
 * client the first time it was dragged.
 */
export const UNTITLED_EVENT = '(no title)';

/** "9:05 AM" in the given zone — the label both timelines print on event blocks. */
export const formatClockTime = (epochMs: number, timeZone: string): string =>
  Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timeZone)
    .toPlainTime()
    .toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "9:05 AM" from a wall-clock `HH:MM` value with no zone conversion. */
export const formatPlainTime = (time: string): string =>
  Temporal.PlainTime.from(time).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

/** "Tue 14 · 09:00–10:30" — a find-a-time slot chip, identical on both bars. */
export const formatSlotLabel = (slot: FreeSlot): string => {
  const day = Temporal.PlainDate.from(slot.date).toLocaleString('en-US', {
    day: 'numeric',
    weekday: 'short',
  });
  return `${day} · ${slot.startTime}–${slot.endTime}`;
};
