import { describe, expect, it } from 'vite-plus/test';
import { plainDateToUtcMs } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';
import { EventRecord, TaskRecord } from '../types.ts';
import {
  cleanSearchQuery,
  EMPTY_SEARCH_QUERY,
  eventInDateRange,
  eventMatchesQuery,
  hasSearchFilters,
  isBlankSearchQuery,
  queryTerms,
  searchQueryKey,
  searchQueryOfKey,
  taskMatchesQuery,
  toggleSearchKey,
  withoutSearchFilter,
} from './query.ts';

const VIENNA = 'Europe/Vienna';
const at = (wall: string): number =>
  Temporal.PlainDateTime.from(wall).toZonedDateTime(VIENNA).epochMilliseconds;

const event = (overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'work',
    endUtc: at('2026-10-14T10:00'),
    etag: null,
    id: 'e1',
    isAllDay: false,
    startUtc: at('2026-10-14T09:00'),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Harbour planning',
    updatedAt: 0,
    ...overrides,
  });

const task = (overrides: Partial<TaskRecord> = {}) =>
  new TaskRecord({
    accountId: 'acc',
    id: 't1',
    listId: 'groceries',
    provider: 'google',
    status: 'needsAction',
    title: 'Harbour fish',
    updatedAt: 0,
    ...overrides,
  });

describe('the query struct', () => {
  it('cleans blanks away, so equal searches are equal values and keys', () => {
    expect(
      cleanSearchQuery({
        calendars: [],
        location: '  ',
        people: [' Anna ', ''],
        terms: [' a ', ''],
      }),
    ).toEqual({ people: ['Anna'], terms: ['a'] });
    expect(searchQueryKey({ calendars: ['b', 'a'], terms: ['x'] })).toBe(
      searchQueryKey({ calendars: ['a', 'b'], location: '', terms: ['x'] }),
    );
  });

  it('reads a key back, and nothing from a key that does not parse', () => {
    const query = { from: '2026-10-01', kind: 'task' as const, terms: ['fish'] };
    expect(searchQueryOfKey(searchQueryKey(query))).toEqual(query);
    expect(searchQueryOfKey('not json')).toEqual(EMPTY_SEARCH_QUERY);
    expect(searchQueryOfKey('{"kind":"note","terms":[]}')).toEqual(EMPTY_SEARCH_QUERY);
  });

  it('tells filters, words and a blank query apart', () => {
    expect(hasSearchFilters({ terms: ['a'] })).toBe(false);
    expect(hasSearchFilters({ allDay: false, terms: [] })).toBe(true);
    expect(isBlankSearchQuery({ terms: ['  '] })).toBe(true);
    expect(isBlankSearchQuery({ kind: 'event', terms: [] })).toBe(false);
    expect(queryTerms({ terms: ['Café harbour', 'X'] })).toEqual(['cafe', 'harbour', 'x']);
  });
});

describe('eventInDateRange', () => {
  it('reads an all-day event by its dates, the end date exclusive', () => {
    const span = {
      endDate: '2026-10-03',
      endUtc: plainDateToUtcMs('2026-10-03'),
      isAllDay: true,
      startDate: '2026-10-01',
      startUtc: plainDateToUtcMs('2026-10-01'),
    };
    expect(eventInDateRange(span, '2026-10-02', '2026-10-02', VIENNA)).toBe(true);
    expect(eventInDateRange(span, '2026-10-03', undefined, VIENNA)).toBe(false);
    expect(eventInDateRange(span, undefined, '2026-09-30', VIENNA)).toBe(false);
  });

  it('reads a timed event by its days in the zone; one ending at midnight is its start day’s', () => {
    const late = {
      endUtc: at('2026-10-15T00:00'),
      isAllDay: false,
      startUtc: at('2026-10-14T22:00'),
    };
    expect(eventInDateRange(late, '2026-10-15', '2026-10-15', VIENNA)).toBe(false);
    expect(eventInDateRange(late, '2026-10-14', '2026-10-14', VIENNA)).toBe(true);
    // 23:30 Vienna is 21:30 UTC: still the 14th in Vienna, whatever UTC says.
    const night = {
      endUtc: at('2026-10-14T23:45'),
      isAllDay: false,
      startUtc: at('2026-10-14T23:30'),
    };
    expect(eventInDateRange(night, '2026-10-14', '2026-10-14', VIENNA)).toBe(true);
    expect(eventInDateRange(night, undefined, undefined, VIENNA)).toBe(true);
  });
});

describe('eventMatchesQuery', () => {
  it('needs every word, and with no words only the filters', () => {
    expect(eventMatchesQuery(event(), { terms: ['harbour'] }, VIENNA)).toBe(true);
    expect(eventMatchesQuery(event(), { terms: ['harbour', 'lunch'] }, VIENNA)).toBe(false);
    expect(eventMatchesQuery(event(), { kind: 'event', terms: [] }, VIENNA)).toBe(true);
  });

  it('picks events by calendar; a lists filter alone leaves events out; kind task too', () => {
    expect(eventMatchesQuery(event(), { calendars: ['acc:work'], terms: [] }, VIENNA)).toBe(true);
    expect(eventMatchesQuery(event(), { calendars: ['acc:home'], terms: [] }, VIENNA)).toBe(false);
    expect(eventMatchesQuery(event(), { lists: ['acc:groceries'], terms: [] }, VIENNA)).toBe(false);
    expect(
      eventMatchesQuery(
        event(),
        { calendars: ['acc:work'], lists: ['acc:groceries'], terms: [] },
        VIENNA,
      ),
    ).toBe(true);
    expect(eventMatchesQuery(event(), { kind: 'task', terms: [] }, VIENNA)).toBe(false);
  });

  it('reads all-day or not, the place (text or picked name) and the people, folded', () => {
    expect(eventMatchesQuery(event(), { allDay: true, terms: [] }, VIENNA)).toBe(false);
    expect(eventMatchesQuery(event(), { allDay: false, terms: [] }, VIENNA)).toBe(true);
    const placed = event({ location: 'Café Central, Wien' });
    expect(eventMatchesQuery(placed, { location: 'cafe central', terms: [] }, VIENNA)).toBe(true);
    expect(eventMatchesQuery(placed, { location: 'Graz', terms: [] }, VIENNA)).toBe(false);
    const named = event({
      geo: { lat: 0, lng: 0, name: 'Hafen Wien', source: 'x' } as EventRecord['geo'],
    });
    expect(eventMatchesQuery(named, { location: 'hafen', terms: [] }, VIENNA)).toBe(true);
    const guests = event({
      attendees: [
        { displayName: 'Anna Ëxample', email: 'anna@example.com', responseStatus: 'accepted' },
      ],
      organizerEmail: 'boss@example.com',
    });
    expect(eventMatchesQuery(guests, { people: ['anna example'], terms: [] }, VIENNA)).toBe(true);
    expect(eventMatchesQuery(guests, { people: ['boss@'], terms: [] }, VIENNA)).toBe(true);
    expect(eventMatchesQuery(guests, { people: ['anna', 'bob'], terms: [] }, VIENNA)).toBe(false);
  });

  it('applies the date range', () => {
    expect(eventMatchesQuery(event(), { from: '2026-10-14', terms: [] }, VIENNA)).toBe(true);
    expect(eventMatchesQuery(event(), { from: '2026-10-15', terms: [] }, VIENNA)).toBe(false);
  });
});

describe('taskMatchesQuery', () => {
  it('picks tasks by list and by kind; calendars alone leave tasks out', () => {
    expect(taskMatchesQuery(task(), { lists: ['acc:groceries'], terms: [] })).toBe(true);
    expect(taskMatchesQuery(task(), { lists: ['acc:work'], terms: [] })).toBe(false);
    expect(taskMatchesQuery(task(), { calendars: ['acc:work'], terms: [] })).toBe(false);
    expect(taskMatchesQuery(task(), { kind: 'event', terms: [] })).toBe(false);
    expect(taskMatchesQuery(task(), { kind: 'task', terms: ['fish'] })).toBe(true);
  });

  it('leaves tasks out of a filter only events can answer', () => {
    expect(taskMatchesQuery(task(), { location: 'Hafen', terms: [] })).toBe(false);
    expect(taskMatchesQuery(task(), { people: ['Anna'], terms: [] })).toBe(false);
    expect(taskMatchesQuery(task(), { allDay: true, terms: [] })).toBe(false);
  });

  it('needs a due day inside a date range', () => {
    expect(taskMatchesQuery(task(), { from: '2026-10-01', terms: [] })).toBe(false);
    expect(
      taskMatchesQuery(task({ dueDate: '2026-10-05' }), {
        from: '2026-10-01',
        terms: [],
        to: '2026-10-31',
      }),
    ).toBe(true);
    expect(taskMatchesQuery(task({ dueDate: '2026-11-01' }), { terms: [], to: '2026-10-31' })).toBe(
      false,
    );
  });
});

describe('withoutSearchFilter and toggleSearchKey', () => {
  const full = {
    allDay: true,
    calendars: ['acc:work', 'acc:home'],
    from: '2026-10-01',
    kind: 'event' as const,
    location: 'Hafen',
    people: ['Anna'],
    terms: ['x'],
    to: '2026-10-31',
  };

  it('takes one filter away, a calendar by its key, the rest kept', () => {
    expect(withoutSearchFilter(full, 'dates')).not.toHaveProperty('from');
    expect(withoutSearchFilter(full, 'dates')).not.toHaveProperty('to');
    expect(withoutSearchFilter(full, 'calendar', 'acc:work').calendars).toEqual(['acc:home']);
    expect(
      withoutSearchFilter({ calendars: ['acc:work'], terms: [] }, 'calendar', 'acc:work'),
    ).toEqual({
      terms: [],
    });
    expect(withoutSearchFilter(full, 'people')).toEqual({
      ...full,
      people: undefined,
      terms: ['x'],
    });
  });

  it('toggles a key', () => {
    expect(toggleSearchKey(undefined, 'a')).toEqual(['a']);
    expect(toggleSearchKey(['a', 'b'], 'a')).toEqual(['b']);
  });
});
