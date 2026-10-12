import { Temporal } from '../time/temporal.ts';
import type { EventRecord } from '../types.ts';

/** A bookable gap, in the caller's wall clock. */
export interface FreeSlot {
  readonly date: string;
  readonly endTime: string;
  readonly startTime: string;
}

export interface FindSlotsConstraints {
  /** ISO weekday numbers (1 = Monday … 7 = Sunday); absent = any day. */
  readonly daysOfWeek?: ReadonlyArray<number> | undefined;
  readonly durationMinutes: number;
  /** Wall-clock 'HH:MM' bounds of the daily search window. */
  readonly earliestTime?: string | undefined;
  readonly latestTime?: string | undefined;
  /** Inclusive 'YYYY-MM-DD' bounds of the date window. */
  readonly windowEndDate: string;
  readonly windowStartDate: string;
}

export interface FindSlotsContext {
  readonly maxSlots?: number | undefined;
  /** Slots never start in the past. */
  readonly nowUtc: number;
  /**
   * `HH:MM` wall clock: each gap's slot is placed as near this time as
   * the gap allows — a lunch slot sits at lunchtime, not where the gap
   * opens. Absent, a slot starts where its gap does.
   */
  readonly preferredTime?: string | undefined;
  readonly timeZone: string;
}

const DEFAULT_EARLIEST = '08:00';
const DEFAULT_LATEST = '20:00';
const DEFAULT_MAX_SLOTS = 10;
const ROUNDING_MINUTES = 15;

const timeParts = (time: string): { hour: number; minute: number } => {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return { hour, minute };
};

const wallClockMs = (date: Temporal.PlainDate, time: string, timeZone: string): number => {
  const { hour, minute } = timeParts(time);
  return date
    .toZonedDateTime({ plainTime: new Temporal.PlainTime(hour, minute), timeZone })
    .toInstant().epochMilliseconds;
};

const formatTime = (epochMs: number, timeZone: string): string => {
  const time = Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timeZone)
    .toPlainTime();
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
};

/**
 * Deterministic free-slot search over an assembled event window (recurring
 * instances already expanded — the shape `getEventsInRange` returns). Wall
 * clock throughout: the daily bounds are interpreted per day in the given
 * zone, so DST days behave like their calendars, not like their UTC math.
 * Ranking is chronological — the constraints are the preference language;
 * `rankSlotsAround` reorders for a named time of day.
 */
export const findFreeSlots = (
  events: ReadonlyArray<EventRecord>,
  constraints: FindSlotsConstraints,
  context: FindSlotsContext,
): Array<FreeSlot> => {
  const { durationMinutes } = constraints;
  if (durationMinutes <= 0) {
    return [];
  }
  const earliest = constraints.earliestTime ?? DEFAULT_EARLIEST;
  const latest = constraints.latestTime ?? DEFAULT_LATEST;
  const maxSlots = context.maxSlots ?? DEFAULT_MAX_SLOTS;
  const durationMs = durationMinutes * 60_000;
  const roundingMs = ROUNDING_MINUTES * 60_000;

  // All-day entries mark days, they don't occupy hours; cancelled rows are
  // filtered defensively (assembleWindow already drops shadowed ones).
  const busy = events
    .filter((event) => !event.isAllDay && event.status !== 'cancelled')
    .map((event) => ({ endUtc: event.endUtc, startUtc: event.startUtc }))
    .sort((a, b) => a.startUtc - b.startUtc);

  const slots: Array<FreeSlot> = [];
  const windowEnd = Temporal.PlainDate.from(constraints.windowEndDate);
  let day = Temporal.PlainDate.from(constraints.windowStartDate);

  /**
   * The slot a gap holds, or none when it is too short. With a preferred
   * time the slot is centred on it, to the quarter hour, as far as the gap
   * allows; otherwise it starts where the gap does.
   */
  const slotIn = (gapStart: number, gapEnd: number): FreeSlot | undefined => {
    if (gapEnd - gapStart < durationMs) {
      return undefined;
    }
    let start = gapStart;
    if (context.preferredTime !== undefined) {
      const centred =
        Math.round(
          (wallClockMs(day, context.preferredTime, context.timeZone) - durationMs / 2) / roundingMs,
        ) * roundingMs;
      start = Math.min(Math.max(centred, gapStart), gapEnd - durationMs);
    }
    return {
      date: day.toString(),
      endTime: formatTime(start + durationMs, context.timeZone),
      startTime: formatTime(start, context.timeZone),
    };
  };

  while (Temporal.PlainDate.compare(day, windowEnd) <= 0 && slots.length < maxSlots) {
    const allowed =
      !constraints.daysOfWeek ||
      constraints.daysOfWeek.length === 0 ||
      constraints.daysOfWeek.includes(day.dayOfWeek);
    if (!allowed) {
      day = day.add({ days: 1 });
      continue;
    }

    const dayStart = wallClockMs(day, earliest, context.timeZone);
    const dayEnd = wallClockMs(day, latest, context.timeZone);
    // Never offer the past; align the ragged first edge to a clean quarter.
    let cursor = Math.max(dayStart, Math.ceil(context.nowUtc / roundingMs) * roundingMs);

    for (const interval of busy) {
      if (interval.endUtc <= cursor) {
        continue;
      }
      if (interval.startUtc >= dayEnd) {
        break;
      }
      const slot = slotIn(cursor, interval.startUtc);
      if (slot) {
        slots.push(slot);
        if (slots.length >= maxSlots) {
          return slots;
        }
      }
      cursor = Math.max(cursor, interval.endUtc);
    }

    const tail = slotIn(cursor, dayEnd);
    if (tail && slots.length < maxSlots) {
      slots.push(tail);
    }

    day = day.add({ days: 1 });
  }

  return slots;
};
