import type { AppleCalendarError } from '@calendar/apple-calendar';
import { assembleWindow, type EventRecord } from '@calendar/core';
import { EventRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { AppleCalendarEvents } from './appleCalendarEvents.ts';

/** The stored Google rows of [start, end) with their series expanded, plus what `apple` reads. */
const assembleRange = <E, R>(
  rangeStartUtc: number,
  rangeEndUtc: number,
  apple: Effect.Effect<ReadonlyArray<EventRecord>, E, R>,
): Effect.Effect<ReadonlyArray<EventRecord>, E | SqlError, EventRepo | R> =>
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
    const appleEvents = yield* apple;
    return appleEvents.length === 0
      ? result
      : [...result, ...appleEvents].sort((a, b) => a.startUtc - b.startUtc);
  });

/**
 * Every event instance overlapping [start, end) on a visible calendar:
 * stored Google rows with their series expanded, plus the Apple Calendar
 * events EventKit answers live. The `getEventsInRange` rpc and the
 * notification planner share this, so both see the same calendar.
 */
export const loadEventsInRange = (
  rangeStartUtc: number,
  rangeEndUtc: number,
  options: {
    /** false skips the EventKit round trip (a planner that would discard the rows anyway). */
    readonly apple: boolean;
  } = { apple: true },
): Effect.Effect<ReadonlyArray<EventRecord>, SqlError, AppleCalendarEvents | EventRepo> =>
  assembleRange(
    rangeStartUtc,
    rangeEndUtc,
    options.apple
      ? Effect.gen(function* () {
          return yield* (yield* AppleCalendarEvents).eventsInRange(rangeStartUtc, rangeEndUtc);
        })
      : Effect.succeed([]),
  );

/**
 * `loadEventsInRange`, failing when EventKit cannot be read instead of
 * leaving the Apple events out: for a lookup of an Apple event, where no
 * row must mean the event is gone.
 */
export const loadEventsInRangeOrFail = (
  rangeStartUtc: number,
  rangeEndUtc: number,
): Effect.Effect<
  ReadonlyArray<EventRecord>,
  AppleCalendarError | SqlError,
  AppleCalendarEvents | EventRepo
> =>
  assembleRange(
    rangeStartUtc,
    rangeEndUtc,
    Effect.gen(function* () {
      return yield* (yield* AppleCalendarEvents).eventsInRangeOrFail(rangeStartUtc, rangeEndUtc);
    }),
  );
