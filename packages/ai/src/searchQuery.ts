import {
  cleanSearchQuery,
  foldSearchText,
  SEARCH_WINDOW_YEARS,
  type SearchKind,
  type SearchQuery,
  Temporal,
} from '@calendar/core';
import { ModelUnavailableError, type LanguageModel } from './model.ts';
import {
  clearsSearchDates,
  searchAllDayOf,
  searchKindOf,
  searchWindowOf,
  statesSearchDate,
} from './searchGrounding.ts';
import { meaningfulText, realDate, upcomingDays } from './shared.ts';

/**
 * A search turn: the filters as they stand, a sentence ("lunch with Anna
 * last month", "only tasks", "in Vienna"), and the filters as they
 * should be. Stateless like a refinement — the thread keeps the query —
 * and held against the words the same way: the model extracts, the code
 * decides. A value counts only where the sentence holds it (a place, a
 * person, a calendar's name are in its words; the kind and all-day are
 * read from the words alone; dates are the code's where it reads them);
 * a field the sentence does not touch stays as it was, whatever the model
 * returned.
 */

/** What the model is asked for: the query with calendars and lists by name. */
export interface SearchQueryParse {
  readonly allDay?: boolean | undefined;
  readonly calendars?: ReadonlyArray<string> | undefined;
  readonly from?: string | undefined;
  readonly kind?: string | undefined;
  readonly lists?: ReadonlyArray<string> | undefined;
  readonly location?: string | undefined;
  readonly people?: ReadonlyArray<string> | undefined;
  readonly terms?: ReadonlyArray<string> | undefined;
  readonly to?: string | undefined;
}

/** Guided-generation schema; kept in sync with SearchQueryParse by hand. */
export const SEARCH_QUERY_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    allDay: { type: 'boolean' },
    calendars: {
      description: 'calendar names from the list',
      items: { type: 'string' },
      type: 'array',
    },
    from: { description: 'YYYY-MM-DD', type: 'string' },
    kind: { enum: ['event', 'task'], type: 'string' },
    lists: { description: 'list names from the list', items: { type: 'string' }, type: 'array' },
    location: { type: 'string' },
    people: { items: { type: 'string' }, type: 'array' },
    terms: { items: { type: 'string' }, type: 'array' },
    to: { description: 'YYYY-MM-DD', type: 'string' },
  },
  required: ['terms'],
  type: 'object',
} as const;

/** The line the current filters follow in the prompt, as one line of JSON. */
export const SEARCH_QUERY_CURRENT_MARKER = 'Current filters: ';
/** The line the user's words follow in the prompt. */
export const SEARCH_QUERY_PHRASE_MARKER = 'Search: ';

/** A calendar or a list as the prompt names it and the query keys it. */
export interface SearchContainer {
  readonly key: string;
  readonly name: string;
}

const monthSpan = (date: Temporal.PlainDate): string => {
  const first = date.with({ day: 1 });
  return `${first.toString()} – ${first.add({ months: 1 }).subtract({ days: 1 }).toString()}`;
};

/** The query as the model sees it: calendars and lists by name. */
const named = (
  query: SearchQuery,
  calendars: ReadonlyArray<SearchContainer>,
  lists: ReadonlyArray<SearchContainer>,
): SearchQueryParse => {
  const clean = cleanSearchQuery(query);
  const nameOf = (containers: ReadonlyArray<SearchContainer>, key: string) =>
    containers.find((container) => container.key === key)?.name ?? key;
  return {
    ...clean,
    ...(clean.calendars ? { calendars: clean.calendars.map((key) => nameOf(calendars, key)) } : {}),
    ...(clean.lists ? { lists: clean.lists.map((key) => nameOf(lists, key)) } : {}),
  };
};

export const buildSearchQueryPrompt = ({
  calendars,
  current,
  lists,
  phrase,
  referenceDate,
  timeZone,
}: {
  calendars: ReadonlyArray<SearchContainer>;
  current: SearchQuery;
  lists: ReadonlyArray<SearchContainer>;
  phrase: string;
  referenceDate: string;
  timeZone: string;
}): string => {
  const today = Temporal.PlainDate.from(referenceDate);
  return [
    'Here are the current search filters as JSON and what the user typed.',
    'Return the whole filter set with only what the words change; copy every',
    'other field exactly as it is.',
    `Today is ${referenceDate} in time zone ${timeZone}.`,
    'Resolve relative days by picking from this list, never by computing:',
    `${upcomingDays(referenceDate)}.`,
    `This month is ${monthSpan(today)}; last month was ${monthSpan(today.subtract({ months: 1 }))};`,
    `next month is ${monthSpan(today.add({ months: 1 }))}. from and to are inclusive YYYY-MM-DD days.`,
    `Calendars: ${calendars.map((calendar) => calendar.name).join(', ') || 'none'}.`,
    `Lists: ${lists.map((list) => list.name).join(', ') || 'none'}.`,
    'Name a calendar or a list only when the words name it.',
    'kind is "task" for to-dos, tasks or reminders only, "event" for events or',
    'meetings only. allDay only when the words say all-day.',
    'people: names or addresses after "with". location: a place after "in" or "at".',
    'Plain words you cannot place are terms — keep them as they are. Never',
    'invent a filter, and never write placeholders like "unknown".',
    `${SEARCH_QUERY_CURRENT_MARKER}${JSON.stringify(named(current, calendars, lists))}`,
    `${SEARCH_QUERY_PHRASE_MARKER}${phrase}`,
  ].join('\n');
};

export type SearchQueryResult =
  | { readonly kind: 'parsed'; readonly query: SearchQuery }
  | { readonly kind: 'rejected'; readonly reason: string };

const fold = (value: string): string => foldSearchText(value).replaceAll('ß', 'ss');

/** The value is in the words: a place, a person or a name the model did not make up. */
const inPhrase = (value: string, phrase: string): boolean => fold(phrase).includes(fold(value));

/** A month or a window word the model put in the place field ("in October"). */
const NOT_A_PLACE =
  /^(?:january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|marz|mai|juni|juli|oktober|dezember|today|tomorrow|yesterday|heute|gestern|this week|next week|last week)$/;

/**
 * The keys of the containers the model named, each named in the words:
 * an exact (folded) name first, else one whose name starts with what the
 * model wrote — two such, and the name says nothing. Unknown names drop.
 */
const keysOf = (
  names: ReadonlyArray<string> | undefined,
  containers: ReadonlyArray<SearchContainer>,
  phrase: string,
  kept: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined => {
  if (names === undefined) {
    return undefined;
  }
  const keys = names.flatMap((raw) => {
    const name = meaningfulText(raw);
    if (name === undefined) {
      return [];
    }
    const exact = containers.filter((container) => fold(container.name) === fold(name));
    const matched =
      exact.length > 0
        ? exact
        : containers.filter((container) => fold(container.name).startsWith(fold(name)));
    if (exact.length === 0 && matched.length !== 1) {
      return [];
    }
    // A name the words say now, or one already chosen ("also Family").
    return matched
      .filter((container) => inPhrase(name, phrase) || (kept ?? []).includes(container.key))
      .map((container) => container.key);
  });
  return keys.length > 0 ? [...new Set(keys)] : undefined;
};

const yearsFrom = (referenceDate: string, years: number): string =>
  Temporal.PlainDate.from(referenceDate).add({ years }).toString();

/**
 * The new query: `current` with what the words change. Dates are the
 * code's where it reads them (`searchWindowOf`), else the model's valid
 * days when the words say when at all, swapped if backwards, held to the
 * search window (two years either side of today); kind and all-day come
 * from the words alone; a place, people and calendar or list names count
 * only when they are in the words; terms only when typed now or before.
 * Anything the words do not touch is `current`'s.
 */
export const normalizeSearchQuery = (
  parse: SearchQueryParse,
  {
    calendars,
    current,
    lists,
    phrase,
    referenceDate,
  }: {
    calendars: ReadonlyArray<SearchContainer>;
    current: SearchQuery;
    lists: ReadonlyArray<SearchContainer>;
    phrase: string;
    referenceDate: string;
  },
): SearchQueryResult => {
  const was = cleanSearchQuery(current);

  // When.
  let from = was.from;
  let to = was.to;
  if (clearsSearchDates(phrase)) {
    from = undefined;
    to = undefined;
  } else {
    const window = searchWindowOf(phrase, referenceDate);
    if (window) {
      ({ from, to } = window);
    } else if (statesSearchDate(phrase, referenceDate)) {
      const modelFrom = realDate(parse.from);
      const modelTo = realDate(parse.to);
      if (modelFrom !== undefined || modelTo !== undefined) {
        from = modelFrom;
        to = modelTo;
      }
    }
  }
  if (from !== undefined && to !== undefined && from > to) {
    [from, to] = [to, from];
  }
  const earliest = yearsFrom(referenceDate, -SEARCH_WINDOW_YEARS);
  const latest = yearsFrom(referenceDate, SEARCH_WINDOW_YEARS);
  if ((from !== undefined && from > latest) || (to !== undefined && to < earliest)) {
    return { kind: 'rejected', reason: 'Search covers two years either side of today.' };
  }
  if (from !== undefined && from < earliest) {
    from = earliest;
  }
  if (to !== undefined && to > latest) {
    to = latest;
  }

  // Which kind, all-day or not: the words alone.
  const kindSaid = searchKindOf(phrase);
  const kind: SearchKind | undefined =
    kindSaid === undefined ? was.kind : kindSaid === 'any' ? undefined : kindSaid;
  const allDaySaid = searchAllDayOf(phrase);
  const allDay = allDaySaid ?? was.allDay;

  // Where and with whom: values that are in the words.
  const place = meaningfulText(parse.location);
  const location =
    place !== undefined && inPhrase(place, phrase) && !NOT_A_PLACE.test(fold(place))
      ? place
      : was.location;
  // A person the words name now, or one already chosen ("also with Bob" keeps Anna).
  const said = (parse.people ?? []).flatMap((person) => {
    const name = meaningfulText(person);
    return name !== undefined &&
      (inPhrase(name, phrase) || (was.people ?? []).some((before) => fold(before) === fold(name)))
      ? [name]
      : [];
  });
  const people = said.length > 0 ? [...new Set(said)] : was.people;

  // Calendars and lists the words name.
  const calendarKeys = keysOf(parse.calendars, calendars, phrase, was.calendars) ?? was.calendars;
  const listKeys = keysOf(parse.lists, lists, phrase, was.lists) ?? was.lists;

  // Words: typed now or before; none left, the ones before stay.
  const terms = (parse.terms ?? []).flatMap((term) => {
    const word = meaningfulText(term);
    return word !== undefined &&
      (inPhrase(word, phrase) || was.terms.some((before) => fold(before) === fold(word)))
      ? [word]
      : [];
  });

  return {
    kind: 'parsed',
    query: cleanSearchQuery({
      ...(allDay === undefined ? {} : { allDay }),
      ...(calendarKeys ? { calendars: calendarKeys } : {}),
      ...(from === undefined ? {} : { from }),
      ...(kind === undefined ? {} : { kind }),
      ...(listKeys ? { lists: listKeys } : {}),
      ...(location === undefined ? {} : { location }),
      ...(people ? { people } : {}),
      terms: terms.length > 0 ? terms : was.terms,
      ...(to === undefined ? {} : { to }),
    }),
  };
};

/**
 * One search turn. Only the model call is impure; the prompt and the
 * merge either side of it are pure, so this runs end to end against a
 * fake model like `parseRefine`.
 */
export const parseSearchQuery = async (
  model: LanguageModel,
  input: {
    calendars: ReadonlyArray<SearchContainer>;
    current: SearchQuery;
    lists: ReadonlyArray<SearchContainer>;
    phrase: string;
    referenceDate: string;
    timeZone: string;
  },
): Promise<SearchQueryResult> => {
  if (!input.phrase.trim()) {
    return { kind: 'rejected', reason: 'Say what to look for.' };
  }
  if ((await model.status()) !== 'ready') {
    throw new ModelUnavailableError({ message: 'No on-device model is available.' });
  }
  let raw: unknown;
  try {
    raw = await model.generateJson({
      jsonSchema: SEARCH_QUERY_JSON_SCHEMA,
      prompt: buildSearchQueryPrompt(input),
    });
  } catch {
    return { kind: 'rejected', reason: "That couldn't be read — try rephrasing." };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'rejected', reason: "That couldn't be read — try rephrasing." };
  }
  return normalizeSearchQuery(raw as SearchQueryParse, input);
};
