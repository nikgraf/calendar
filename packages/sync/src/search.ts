import {
  buildSearchResults,
  EMPTY_SEARCH_RESULTS,
  engineZoneId,
  type EventRecord,
  eventMatchesSearch,
  overriddenSlots,
  type SearchResults,
  searchTerms,
  searchWindow,
  seriesSearchOccurrences,
  taskMatchesSearch,
} from '@calendar/core';
import { EventRepo, TaskRepo } from '@calendar/db';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { AppleCalendarEvents } from './appleCalendarEvents.ts';

/**
 * The `search` rpc: what the views can show that holds every word of
 * `query`, over SEARCH_WINDOW_YEARS either side of today. Events are the
 * rows the range query reads (`EventRepo.getWindow`: visible calendars,
 * no mirror copies, no cancelled rows) and the Apple events EventKit
 * answers for the window. A matching series is not expanded over the
 * whole window — an hourly one would pass the expander's cap and drop out
 * — but walked from now to its next occurrence that is not over, else its
 * latest one (`seriesSearchOccurrences`); an override is a row of its own,
 * found by its own text. Tasks are every task of the visible lists. All
 * of it is matched in TypeScript, so accents and case fold the same way on
 * every engine.
 */
export const searchCalendar = (
  query: string,
  timeZone: string,
): Effect.Effect<SearchResults, SqlError, AppleCalendarEvents | EventRepo | TaskRepo> =>
  Effect.gen(function* () {
    const terms = searchTerms(query);
    if (terms.length === 0) {
      return EMPTY_SEARCH_RESULTS;
    }
    const zone = engineZoneId(timeZone);
    const nowMs = yield* Clock.currentTimeMillis;
    const { endUtc, startUtc } = searchWindow(nowMs, zone);
    const matches = (event: EventRecord) => eventMatchesSearch(event, terms);

    const stored = yield* (yield* EventRepo).getWindow(startUtc, endUtc);
    const slotsOf = overriddenSlots(stored.overrides);
    const skipped: Array<string> = [];
    const series = stored.masters.filter(matches).flatMap((master) => {
      try {
        return seriesSearchOccurrences(master, slotsOf(master), {
          nowMs,
          rangeEndUtc: endUtc,
          rangeStartUtc: startUtc,
          timeZone: zone,
        });
      } catch (error) {
        // As in the views: one broken rule must not fail the search.
        skipped.push(`${master.calendarId}/${master.id}: ${String(error)}`);
        return [];
      }
    });
    if (skipped.length > 0) {
      yield* Effect.logWarning('recurring masters skipped in search', { skipped });
    }
    // Apple Calendar events are never stored: EventKit expands its own series.
    const apple = (yield* (yield* AppleCalendarEvents).eventsInRange(startUtc, endUtc)).filter(
      matches,
    );
    const tasks = (yield* (yield* TaskRepo).getVisible()).filter((task) =>
      taskMatchesSearch(task, terms),
    );
    return buildSearchResults({
      events: [...stored.singles.filter(matches), ...series, ...apple],
      nowMs,
      tasks,
      timeZone: zone,
    });
  });
