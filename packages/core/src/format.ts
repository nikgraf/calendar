import type { FreeSlot } from './scheduling/findSlots.ts';
import { Temporal } from './time/temporal.ts';

/** "9:05 AM" in the given zone — the label both timelines print on event blocks. */
export const formatClockTime = (epochMs: number, timeZone: string): string =>
  Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timeZone)
    .toPlainTime()
    .toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "Tue 14 · 09:00–10:30" — a find-a-time slot chip, identical on both bars. */
export const formatSlotLabel = (slot: FreeSlot): string => {
  const day = Temporal.PlainDate.from(slot.date).toLocaleString('en-US', {
    day: 'numeric',
    weekday: 'short',
  });
  return `${day} · ${slot.startTime}–${slot.endTime}`;
};
