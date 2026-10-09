import {
  buildSearchResults,
  EMPTY_SEARCH_RESULTS,
  engineZoneId,
  eventMatchesSearch,
  type SearchResults,
  searchTerms,
  searchWindow,
  taskMatchesSearch,
} from '@calendar/core';
import { EventRepo, TaskRepo } from '@calendar/db';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { AppleCalendarEvents } from './appleCalendarEvents.ts';
import { loadEventsInRange } from './eventsInRange.ts';

/**
 * The `search` rpc: what the views can show that holds every word of
 * `query`. Events come through the range query the views use — visible
 * calendars, series expanded with their overrides, mirror copies and
 * cancelled events left out, Apple events from EventKit — over
 * SEARCH_WINDOW_YEARS either side of today; only the series whose master
 * matches are expanded. Tasks are every task of the visible lists. Both
 * are matched in TypeScript, so accents and case fold the same way on
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
    const window = searchWindow(nowMs, zone);
    const events = yield* loadEventsInRange(window.startUtc, window.endUtc, {
      apple: true,
      keep: (event) => eventMatchesSearch(event, terms),
    });
    const tasks = (yield* (yield* TaskRepo).getVisible()).filter((task) =>
      taskMatchesSearch(task, terms),
    );
    return buildSearchResults({ events, nowMs, tasks, timeZone: zone });
  });
