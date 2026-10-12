import {
  buildSearchResults,
  cleanSearchQuery,
  daySpanRange,
  EMPTY_SEARCH_RESULTS,
  engineZoneId,
  type EventRecord,
  eventMatchesFilters,
  eventMatchesQuery,
  isBlankSearchQuery,
  overriddenSlots,
  queryTerms,
  type SearchQuery,
  type SearchResults,
  eventMatchesSearch,
  searchWindow,
  seriesSearchOccurrences,
  taskMatchesQuery,
  Temporal,
} from '@calendar/core';
import { EventRepo, TaskRepo } from '@calendar/db';
import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { AppleCalendarEvents } from './appleCalendarEvents.ts';

/**
 * The span events are read over: the search window, narrowed to the
 * query's days when it has a date range. Empty when the range lies
 * outside the window.
 */
const readWindow = (
  query: SearchQuery,
  nowMs: number,
  zone: string,
): { readonly endUtc: number; readonly startUtc: number } | undefined => {
  const window = searchWindow(nowMs, zone);
  const startUtc =
    query.from === undefined
      ? window.startUtc
      : Math.max(
          window.startUtc,
          daySpanRange(Temporal.PlainDate.from(query.from), 1, zone).startUtc,
        );
  const endUtc =
    query.to === undefined
      ? window.endUtc
      : Math.min(window.endUtc, daySpanRange(Temporal.PlainDate.from(query.to), 1, zone).endUtc);
  return startUtc < endUtc ? { endUtc, startUtc } : undefined;
};

/**
 * The `search` rpc: what the views can show that answers `query` — every
 * word in its text, every filter set — over SEARCH_WINDOW_YEARS either
 * side of today, or the query's own days inside that window. Events are
 * the rows the range query reads (`EventRepo.getWindow`: visible
 * calendars, no mirror copies, no cancelled rows) and the Apple events
 * EventKit answers for the span. A matching series is not expanded over
 * the whole span — an hourly one would pass the expander's cap and drop
 * out — but walked from now to its next occurrence that is not over, else
 * its latest one (`seriesSearchOccurrences`): inside a past range that is
 * the range's last occurrence. An override is a row of its own, found by
 * its own text. Tasks are every task of the visible lists. All of it is
 * matched in TypeScript, so accents and case fold the same way on every
 * engine. A query only for tasks reads no events, and the other way round.
 */
export const searchCalendar = (
  query: SearchQuery,
  timeZone: string,
): Effect.Effect<SearchResults, SqlError, AppleCalendarEvents | EventRepo | TaskRepo> =>
  Effect.gen(function* () {
    const clean = cleanSearchQuery(query);
    if (isBlankSearchQuery(clean)) {
      return EMPTY_SEARCH_RESULTS;
    }
    const zone = engineZoneId(timeZone);
    const nowMs = yield* Clock.currentTimeMillis;
    const terms = queryTerms(clean);
    const wantsEvents = clean.kind !== 'task' && !(clean.lists && !clean.calendars);
    const span = wantsEvents ? readWindow(clean, nowMs, zone) : undefined;
    const matches = (event: EventRecord) => eventMatchesQuery(event, clean, zone);

    const events: Array<EventRecord> = [];
    if (span !== undefined) {
      const { endUtc, startUtc } = span;
      const stored = yield* (yield* EventRepo).getWindow(startUtc, endUtc);
      const slotsOf = overriddenSlots(stored.overrides);
      // A master is judged on what all its occurrences share; the days are
      // the walk's, inside the span.
      const { from: _from, to: _to, ...undated } = clean;
      const skipped: Array<string> = [];
      const series = stored.masters
        .filter(
          (master) =>
            (terms.length === 0 || eventMatchesSearch(master, terms)) &&
            eventMatchesFilters(master, undated, zone),
        )
        .flatMap((master) => {
          try {
            // The walk picks among occurrences that answer the query, its
            // days included: one hit per series, the right one.
            return seriesSearchOccurrences(master, slotsOf(master), {
              accept: matches,
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
      events.push(...stored.singles.filter(matches), ...series, ...apple);
    }
    const tasks =
      clean.kind === 'event'
        ? []
        : (yield* (yield* TaskRepo).getVisible()).filter((task) => taskMatchesQuery(task, clean));
    return buildSearchResults({ events, nowMs, tasks, timeZone: zone });
  });
