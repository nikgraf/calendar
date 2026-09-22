import { assembleWindow, type EventRecord } from '@calendar/core';
import { EventRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { AppleCalendarEvents } from './appleCalendarEvents.ts';

/**
 * Every event instance overlapping [start, end) on a visible calendar:
 * stored Google rows with their series expanded, plus the Apple Calendar
 * events EventKit answers live. The `getEventsInRange` rpc and the
 * notification planner share this, so both see the same calendar.
 */
export const loadEventsInRange = (
  rangeStartUtc: number,
  rangeEndUtc: number,
): Effect.Effect<ReadonlyArray<EventRecord>, SqlError, AppleCalendarEvents | EventRepo> =>
  Effect.gen(function* () {
    const events = yield* EventRepo;
    const window = yield* events.getWindow(rangeStartUtc, rangeEndUtc);
    const skipped: Array<string> = [];
    const result = assembleWindow(window, rangeStartUtc, rangeEndUtc, (master, error) =>
      skipped.push(`${master.calendarId}/${master.id}: ${String(error)}`),
    );
    if (skipped.length > 0) {
      yield* Effect.logWarning('recurring masters skipped in window', { skipped });
    }
    // Apple Calendar events are never stored: EventKit answers the range live.
    const apple = yield* (yield* AppleCalendarEvents).eventsInRange(rangeStartUtc, rangeEndUtc);
    return apple.length === 0
      ? result
      : [...result, ...apple].sort((a, b) => a.startUtc - b.startUtc);
  });
