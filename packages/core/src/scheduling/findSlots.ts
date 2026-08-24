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
 * Ranking is chronological — the constraints are the preference language.
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
      if (interval.startUtc - cursor >= durationMs) {
        slots.push({
          date: day.toString(),
          endTime: formatTime(cursor + durationMs, context.timeZone),
          startTime: formatTime(cursor, context.timeZone),
        });
        if (slots.length >= maxSlots) {
          return slots;
        }
      }
      cursor = Math.max(cursor, interval.endUtc);
    }

    if (dayEnd - cursor >= durationMs && slots.length < maxSlots) {
      slots.push({
        date: day.toString(),
        endTime: formatTime(cursor + durationMs, context.timeZone),
        startTime: formatTime(cursor, context.timeZone),
      });
    }

    day = day.add({ days: 1 });
  }

  return slots;
};
