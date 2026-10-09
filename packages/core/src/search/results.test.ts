import { describe, expect, it } from 'vite-plus/test';
import { plainDateToUtcMs } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';
import { EventRecord, TaskRecord } from '../types.ts';
import {
  buildSearchResults,
  type EventSearchGroup,
  SEARCH_WINDOW_YEARS,
  searchWindow,
} from './results.ts';

const VIENNA = 'Europe/Vienna';
const NEW_YORK = 'America/New_York';
const HOUR = 3_600_000;

/** The instant a wall-clock time names in a zone. */
const at = (wall: string, zone = VIENNA): number =>
  Temporal.PlainDateTime.from(wall).toZonedDateTime(zone).epochMilliseconds;

// The Saturday evening before Vienna leaves summer time (Sunday 03:00 → 02:00).
const now = at('2026-10-24T18:00');

const event = (id: string, start: number, overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: start + HOUR,
    etag: null,
    id,
    isAllDay: false,
    startUtc: start,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: id,
    updatedAt: 0,
    ...overrides,
  });

/** An all-day event over [startDate, endDate), stored the way both mappers store one. */
const allDay = (id: string, startDate: string, endDate: string) =>
  event(id, plainDateToUtcMs(startDate), {
    endDate,
    endUtc: plainDateToUtcMs(endDate),
    isAllDay: true,
    startDate,
  });

/** One occurrence of a series, named the way assembleWindow (and the Apple mapper) name it. */
const occurrence = (seriesId: string, wall: string, overrides: Partial<EventRecord> = {}) => {
  const start = at(wall);
  return event(`${seriesId}__${String(start)}`, start, {
    originalStartUtc: start,
    recurringEventId: seriesId,
    title: seriesId,
    ...overrides,
  });
};

const ids = (group: EventSearchGroup) => group.hits.map((hit) => hit.event.id);

const results = (events: ReadonlyArray<EventRecord>, options: { readonly zone?: string } = {}) =>
  buildSearchResults({ events, nowMs: now, tasks: [], timeZone: options.zone ?? VIENNA });

describe('buildSearchResults: events', () => {
  it('lists what is not over yet soonest first, then the past most recent first', () => {
    const found = results([
      event('tuesday', at('2026-10-20T09:00')),
      event('next-monday', at('2026-11-02T09:00')),
      event('under-way', now - HOUR / 2),
      event('friday', at('2026-10-23T09:00')),
      // Sunday morning, after the clocks went back.
      event('sunday', at('2026-10-25T09:00')),
    ]);
    expect(ids(found.upcoming)).toEqual(['under-way', 'sunday', 'next-monday']);
    expect(ids(found.past)).toEqual(['friday', 'tuesday']);
    expect(found.upcoming.hits.every((hit) => !hit.repeating)).toBe(true);
    expect(found.upcoming.total).toBe(3);
    expect(found.past.total).toBe(2);
  });

  it('collapses a series into its next occurrence, across the clock change', () => {
    const found = results([
      occurrence('standup', '2026-10-10T09:00'),
      occurrence('standup', '2026-10-17T09:00'),
      occurrence('standup', '2026-10-24T09:00'),
      occurrence('standup', '2026-11-07T09:00'),
      // An occurrence moved on its own (an override) is still the series'.
      occurrence('standup', '2026-10-31T09:00', {
        id: 'standup_20261031T080000Z',
        title: 'Late standup',
      }),
    ]);
    expect(found.past.hits).toEqual([]);
    expect(found.upcoming.hits).toHaveLength(1);
    const [hit] = found.upcoming.hits;
    expect(hit?.repeating).toBe(true);
    expect(hit?.event.id).toBe('standup_20261031T080000Z');
    expect(hit?.event.startUtc).toBe(at('2026-10-31T09:00'));
    expect(found.upcoming.total).toBe(1);
  });

  it('shows a series that is over by its latest occurrence, among the past', () => {
    const found = results([
      occurrence('course', '2026-09-30T18:00'),
      occurrence('course', '2026-10-21T18:00'),
      occurrence('course', '2026-10-14T18:00'),
    ]);
    expect(found.upcoming.hits).toEqual([]);
    expect(ids(found.past)).toEqual([`course__${String(at('2026-10-21T18:00'))}`]);
    expect(found.past.hits[0]?.repeating).toBe(true);
  });

  it('keeps series of different accounts and calendars apart', () => {
    const found = results([
      occurrence('shared', '2026-10-26T10:00'),
      occurrence('shared', '2026-10-26T10:00', { accountId: 'other' }),
      occurrence('shared', '2026-10-27T10:00', { calendarId: 'team' }),
      // EventKit: an occurrence of a series carries the series' eventIdentifier.
      occurrence('ek-yoga', '2026-10-26T07:00', {
        accountId: 'apple-calendar',
        calendarId: 'ek-home',
      }),
      occurrence('ek-yoga', '2026-10-28T07:00', {
        accountId: 'apple-calendar',
        calendarId: 'ek-home',
      }),
    ]);
    expect(found.upcoming.hits.map((hit) => [hit.event.accountId, hit.event.calendarId])).toEqual([
      ['apple-calendar', 'ek-home'],
      ['acc', 'cal'],
      ['other', 'cal'],
      ['acc', 'team'],
    ]);
  });

  it('keeps an all-day event upcoming through its last day in the zone', () => {
    // 21:00 in New York is already tomorrow in UTC, where all-day events keep their dates.
    const evening = at('2026-10-24T21:00', NEW_YORK);
    const found = buildSearchResults({
      events: [
        allDay('today', '2026-10-24', '2026-10-25'),
        allDay('yesterday', '2026-10-23', '2026-10-24'),
        event('late-tonight', at('2026-10-24T22:00', NEW_YORK)),
      ],
      nowMs: evening,
      tasks: [],
      timeZone: NEW_YORK,
    });
    expect(plainDateToUtcMs('2026-10-25')).toBeLessThan(evening);
    expect(ids(found.upcoming)).toEqual(['today', 'late-tonight']);
    expect(ids(found.past)).toEqual(['yesterday']);
  });

  it("puts a day's all-day event before its timed ones, by the zone's midnight", () => {
    // UTC midnight on Monday is 01:00 in Vienna, after an event at 00:30.
    const found = results([
      event('night-owl', at('2026-10-26T00:30')),
      allDay('holiday', '2026-10-26', '2026-10-27'),
    ]);
    expect(ids(found.upcoming)).toEqual(['holiday', 'night-owl']);
  });

  it('caps each group and says how many matched', () => {
    const found = buildSearchResults({
      events: [
        event('a', at('2026-10-26T09:00')),
        event('b', at('2026-10-27T09:00')),
        event('c', at('2026-10-28T09:00')),
        event('old', at('2026-10-01T09:00')),
      ],
      limit: 2,
      nowMs: now,
      tasks: [],
      timeZone: VIENNA,
    });
    expect(ids(found.upcoming)).toEqual(['a', 'b']);
    expect(found.upcoming.total).toBe(3);
    expect(ids(found.past)).toEqual(['old']);
    expect(found.past.total).toBe(1);
  });
});

const task = (id: string, overrides: Partial<TaskRecord> = {}) =>
  new TaskRecord({
    accountId: 'acc',
    id,
    listId: 'list',
    provider: 'apple',
    status: 'needsAction',
    title: id,
    updatedAt: 0,
    ...overrides,
  });

describe('buildSearchResults: tasks', () => {
  it('lists open tasks by due day, then undated ones, then the latest completed first', () => {
    const found = buildSearchResults({
      events: [],
      nowMs: now,
      tasks: [
        task('done-long-ago', { completedAt: at('2026-09-01T10:00'), status: 'completed' }),
        task('undated'),
        task('tomorrow', { dueDate: '2026-10-25' }),
        task('done-today', {
          completedAt: at('2026-10-24T10:00'),
          dueDate: '2026-10-30',
          status: 'completed',
        }),
        task('tomorrow-at-nine', { dueDate: '2026-10-25', dueTime: '09:00' }),
        task('overdue', { dueDate: '2026-10-01' }),
        task('another-undated'),
      ],
      timeZone: VIENNA,
    });
    expect(found.tasks.tasks.map((entry) => entry.id)).toEqual([
      'overdue',
      'tomorrow-at-nine',
      'tomorrow',
      'another-undated',
      'undated',
      'done-today',
      'done-long-ago',
    ]);
    expect(found.tasks.total).toBe(7);
  });

  it('caps the tasks too', () => {
    const found = buildSearchResults({
      events: [],
      limit: 1,
      nowMs: now,
      tasks: [task('b'), task('a')],
      timeZone: VIENNA,
    });
    expect(found.tasks).toMatchObject({ tasks: [{ id: 'a' }], total: 2 });
  });
});

describe('searchWindow', () => {
  it('spans whole days in the zone, SEARCH_WINDOW_YEARS either side of today', () => {
    expect(SEARCH_WINDOW_YEARS).toBe(2);
    expect(searchWindow(now, VIENNA)).toEqual({
      endUtc: at('2028-10-25T00:00'),
      startUtc: at('2024-10-24T00:00'),
    });
    // Late evening in New York is the next day in Vienna: each zone's own today.
    const evening = at('2026-10-24T21:00', NEW_YORK);
    expect(searchWindow(evening, NEW_YORK)).toEqual({
      endUtc: at('2028-10-25T00:00', NEW_YORK),
      startUtc: at('2024-10-24T00:00', NEW_YORK),
    });
    expect(searchWindow(evening, VIENNA).startUtc).toBe(at('2024-10-25T00:00'));
  });
});
