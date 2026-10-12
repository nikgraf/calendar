import { Schema } from 'effect';
import { addDaysToPlainDate, toZonedDateTime } from '../time/convert.ts';
import type { EventRecord, TaskRecord } from '../types.ts';
import { eventMatchesSearch, foldSearchText, searchTerms, taskMatchesSearch } from './match.ts';

/**
 * What a search looks for: the words typed, and the filters set by hand
 * (a chip) or by a sentence the model read. An unset field is "any". The
 * same struct is the rpc's payload, the atom's key and the thread's state,
 * so what the chips show is exactly what was searched.
 */

export const SearchKind = Schema.Literals(['event', 'task']);
export type SearchKind = typeof SearchKind.Type;

export const SearchQuery = Schema.Struct({
  /** All-day events only (true) or timed ones only (false). */
  allDay: Schema.optional(Schema.Boolean),
  /** Calendars by `calendarKey` (`accountId:calendarId`). */
  calendars: Schema.optional(Schema.Array(Schema.String)),
  /** `YYYY-MM-DD`, the first day searched. */
  from: Schema.optional(Schema.String),
  kind: Schema.optional(SearchKind),
  /** Task lists by `taskListKeyOf` (`accountId:listId`). */
  lists: Schema.optional(Schema.Array(Schema.String)),
  /** Text the event's place holds. */
  location: Schema.optional(Schema.String),
  /** Each one a guest's name or address, or the organizer's. */
  people: Schema.optional(Schema.Array(Schema.String)),
  /** The words typed; every one must be in the item's text. */
  terms: Schema.Array(Schema.String),
  /** `YYYY-MM-DD`, the last day searched (inclusive). */
  to: Schema.optional(Schema.String),
});
export type SearchQuery = typeof SearchQuery.Type;

export const EMPTY_SEARCH_QUERY: SearchQuery = { terms: [] };

const filled = (values: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined => {
  const kept = (values ?? []).map((value) => value.trim()).filter((value) => value !== '');
  return kept.length > 0 ? kept : undefined;
};

const text = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * The query with its blanks dropped — empty lists, blank text — so two
 * queries that search the same thing are the same value (and the same key).
 */
export const cleanSearchQuery = (query: SearchQuery): SearchQuery => {
  const calendars = filled(query.calendars);
  const lists = filled(query.lists);
  const people = filled(query.people);
  const location = text(query.location);
  const from = text(query.from);
  const to = text(query.to);
  return {
    ...(query.allDay === undefined ? {} : { allDay: query.allDay }),
    ...(calendars ? { calendars } : {}),
    ...(from ? { from } : {}),
    ...(query.kind === undefined ? {} : { kind: query.kind }),
    ...(lists ? { lists } : {}),
    ...(location ? { location } : {}),
    ...(people ? { people } : {}),
    terms: query.terms.map((term) => term.trim()).filter((term) => term !== ''),
    ...(to ? { to } : {}),
  };
};

/** Any filter set beyond the words. */
export const hasSearchFilters = (query: SearchQuery): boolean => {
  const clean = cleanSearchQuery(query);
  return Object.keys(clean).some((key) => key !== 'terms');
};

/** The folded words every match must hold; a term with spaces is several words. */
export const queryTerms = (query: SearchQuery): ReadonlyArray<string> =>
  query.terms.flatMap((term) => searchTerms(term));

/** No words and no filters: nothing to look for. */
export const isBlankSearchQuery = (query: SearchQuery): boolean =>
  queryTerms(query).length === 0 && !hasSearchFilters(query);

/** A query of the words typed, kept as written (the labels show them); matching folds them. */
export const searchQueryFromText = (text: string): SearchQuery => ({
  terms: text.split(/\s+/u).filter((term) => term !== ''),
});

/**
 * One string per distinct search: the cleaned query as JSON, its keys in
 * order (`cleanSearchQuery` writes them sorted) and its key lists sorted —
 * the atom key a search is cached under.
 */
export const searchQueryKey = (query: SearchQuery): string => {
  const clean = cleanSearchQuery(query);
  return JSON.stringify({
    ...clean,
    ...(clean.calendars ? { calendars: [...clean.calendars].sort() } : {}),
    ...(clean.lists ? { lists: [...clean.lists].sort() } : {}),
  });
};

/** The query a key names; a key that does not parse searches nothing. */
export const searchQueryOfKey = (key: string): SearchQuery => {
  try {
    const value: unknown = JSON.parse(key);
    return Schema.is(SearchQuery)(value) ? value : EMPTY_SEARCH_QUERY;
  } catch {
    return EMPTY_SEARCH_QUERY;
  }
};

type Timing = Pick<EventRecord, 'endDate' | 'endUtc' | 'isAllDay' | 'startDate' | 'startUtc'>;

/**
 * The event touches a day from `from` to `to` (inclusive; an unset end is
 * open). An all-day event by its dates (the end date is exclusive), a
 * timed one by the days it covers in `timeZone` — one ending at midnight
 * belongs to its start day.
 */
export const eventInDateRange = (
  event: Timing,
  from: string | undefined,
  to: string | undefined,
  timeZone: string,
): boolean => {
  if (from === undefined && to === undefined) {
    return true;
  }
  let first: string;
  let last: string;
  if (event.isAllDay && event.startDate !== undefined) {
    first = event.startDate;
    last = addDaysToPlainDate(event.endDate ?? addDaysToPlainDate(event.startDate, 1), -1);
  } else {
    first = toZonedDateTime(event.startUtc, timeZone).toPlainDate().toString();
    last = toZonedDateTime(Math.max(event.startUtc, event.endUtc - 1), timeZone)
      .toPlainDate()
      .toString();
  }
  return (to === undefined || first <= to) && (from === undefined || last >= from);
};

const holds = (haystack: string | undefined, needle: string): boolean =>
  haystack !== undefined && foldSearchText(haystack).includes(foldSearchText(needle));

/**
 * The event answers every filter of the query (its words are matched
 * apart, `eventMatchesSearch`). Calendars pick events, lists pick tasks:
 * with only lists set, no event matches. Location is looked for in the
 * place text and the picked place's name; each person must be a guest's
 * name or address, or the organizer's.
 */
export const eventMatchesFilters = (
  event: Pick<
    EventRecord,
    | 'accountId'
    | 'attendees'
    | 'calendarId'
    | 'endDate'
    | 'endUtc'
    | 'geo'
    | 'isAllDay'
    | 'location'
    | 'organizerEmail'
    | 'startDate'
    | 'startUtc'
  >,
  query: SearchQuery,
  timeZone: string,
): boolean => {
  const clean = cleanSearchQuery(query);
  if (clean.kind === 'task') {
    return false;
  }
  if (clean.calendars) {
    if (!clean.calendars.includes(`${event.accountId}:${event.calendarId}`)) {
      return false;
    }
  } else if (clean.lists) {
    return false;
  }
  if (clean.allDay !== undefined && event.isAllDay !== clean.allDay) {
    return false;
  }
  if (!eventInDateRange(event, clean.from, clean.to, timeZone)) {
    return false;
  }
  if (
    clean.location !== undefined &&
    !holds(event.location, clean.location) &&
    !holds(event.geo?.name, clean.location)
  ) {
    return false;
  }
  return (clean.people ?? []).every(
    (person) =>
      holds(event.organizerEmail, person) ||
      (event.attendees ?? []).some(
        (attendee) => holds(attendee.displayName, person) || holds(attendee.email, person),
      ),
  );
};

/**
 * The task answers every filter. A filter only an event can answer — a
 * place, people, all-day or not, calendars without lists — leaves tasks
 * out; a date range needs a due day inside it.
 */
export const taskMatchesFilters = (
  task: Pick<TaskRecord, 'accountId' | 'dueDate' | 'listId'>,
  query: SearchQuery,
): boolean => {
  const clean = cleanSearchQuery(query);
  if (clean.kind === 'event') {
    return false;
  }
  if (clean.location !== undefined || clean.people !== undefined || clean.allDay !== undefined) {
    return false;
  }
  if (clean.lists) {
    if (!clean.lists.includes(`${task.accountId}:${task.listId}`)) {
      return false;
    }
  } else if (clean.calendars) {
    return false;
  }
  if (clean.from !== undefined || clean.to !== undefined) {
    if (task.dueDate === undefined) {
      return false;
    }
    if (
      (clean.from !== undefined && task.dueDate < clean.from) ||
      (clean.to !== undefined && task.dueDate > clean.to)
    ) {
      return false;
    }
  }
  return true;
};

/** Every word in the event's text (none typed: any text) and every filter answered. */
export const eventMatchesQuery = (
  event: EventRecord,
  query: SearchQuery,
  timeZone: string,
): boolean => {
  const terms = queryTerms(query);
  return (
    (terms.length === 0 || eventMatchesSearch(event, terms)) &&
    eventMatchesFilters(event, query, timeZone)
  );
};

/** Every word in the task's text (none typed: any text) and every filter answered. */
export const taskMatchesQuery = (task: TaskRecord, query: SearchQuery): boolean => {
  const terms = queryTerms(query);
  return (terms.length === 0 || taskMatchesSearch(task, terms)) && taskMatchesFilters(task, query);
};
