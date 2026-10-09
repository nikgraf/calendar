import { assembleWindow, type EventRecord } from '@calendar/core';
import { EventRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { AppleCalendarEvents } from './appleCalendarEvents.ts';

/**
 * Every event instance overlapping [start, end) on a visible calendar:
 * stored Google rows with their series expanded, plus the Apple Calendar
 * events EventKit answers live. The `getEventsInRange` rpc, the
 * notification planner and search share this, so all three see the same
 * calendar.
 */
export const loadEventsInRange = (
  rangeStartUtc: number,
  rangeEndUtc: number,
  options: {
    /** false skips the EventKit round trip (a planner that would discard the rows anyway). */
    readonly apple: boolean;
    /**
     * Keeps only the events this accepts. A series' master is asked before
     * it is expanded and stands for every occurrence, so the test must look
     * at what all of them share (the title, the place…), never the times.
     * Search uses it to expand only the series that match.
     */
    readonly keep?: ((event: EventRecord) => boolean) | undefined;
  } = { apple: true },
): Effect.Effect<ReadonlyArray<EventRecord>, SqlError, AppleCalendarEvents | EventRepo> =>
  Effect.gen(function* () {
    const events = yield* EventRepo;
    const { keep } = options;
    const stored = yield* events.getWindow(rangeStartUtc, rangeEndUtc);
    // Overrides stay whole: a cancelled or edited occurrence must still
    // shadow its slot in the series it belongs to.
    const window =
      keep === undefined
        ? stored
        : { ...stored, masters: stored.masters.filter(keep), singles: stored.singles.filter(keep) };
    const skipped: Array<string> = [];
    const result = assembleWindow(window, rangeStartUtc, rangeEndUtc, (master, error) =>
      skipped.push(`${master.calendarId}/${master.id}: ${String(error)}`),
    );
    if (skipped.length > 0) {
      yield* Effect.logWarning('recurring masters skipped in window', { skipped });
    }
    // Apple Calendar events are never stored: EventKit answers the range live.
    const apple = options.apple
      ? (yield* (yield* AppleCalendarEvents).eventsInRange(rangeStartUtc, rangeEndUtc)).filter(
          (event) => keep === undefined || keep(event),
        )
      : [];
    return apple.length === 0
      ? result
      : [...result, ...apple].sort((a, b) => a.startUtc - b.startUtc);
  });
