import { describe, expect, it } from 'vite-plus/test';
import {
  clearsSearchDates,
  isSearchFilterPhrase,
  searchAllDayOf,
  searchKindOf,
  searchWindowOf,
  statesSearchDate,
} from './searchGrounding.ts';

// A Wednesday.
const TODAY = '2026-10-14';
const window = (phrase: string) => searchWindowOf(phrase, TODAY);

describe('searchWindowOf', () => {
  it.each([
    ['standup yesterday', '2026-10-13', '2026-10-13'],
    ['lunch today', '2026-10-14', '2026-10-14'],
    ['dinner tonight', '2026-10-14', '2026-10-14'],
    ['call tomorrow', '2026-10-15', '2026-10-15'],
    ['the day after tomorrow', '2026-10-16', '2026-10-16'],
    ['vorgestern', '2026-10-12', '2026-10-12'],
    ['Termine gestern', '2026-10-13', '2026-10-13'],
    ['this week', '2026-10-12', '2026-10-18'],
    ['next week', '2026-10-19', '2026-10-25'],
    ['meetings last week', '2026-10-05', '2026-10-11'],
    ['letzte Woche', '2026-10-05', '2026-10-11'],
    ['this month', '2026-10-01', '2026-10-31'],
    ['lunch with Anna last month', '2026-09-01', '2026-09-30'],
    ['letzten Monat', '2026-09-01', '2026-09-30'],
    ['next month', '2026-11-01', '2026-11-30'],
    ['this year', '2026-01-01', '2026-12-31'],
    ['letztes Jahr', '2025-01-01', '2025-12-31'],
    ['the past 3 days', '2026-10-12', '2026-10-14'],
    ['the last two weeks', '2026-10-01', '2026-10-14'],
    ['die letzten 3 Monate', '2026-07-15', '2026-10-14'],
    ['last Friday', '2026-10-09', '2026-10-09'],
    ['last Wednesday', '2026-10-07', '2026-10-07'],
    ['harbour in October', '2026-10-01', '2026-10-31'],
    ['im Oktober', '2026-10-01', '2026-10-31'],
    ['last October', '2025-10-01', '2025-10-31'],
    ['last March', '2026-03-01', '2026-03-31'],
    ['next March', '2027-03-01', '2027-03-31'],
    ['trips in may', '2026-05-01', '2026-05-31'],
    ['October 2025', '2025-10-01', '2025-10-31'],
  ])('%s', (phrase, from, to) => {
    expect(window(phrase)).toEqual({ from, to });
  });

  it.each([
    'harbour',
    'between Monday and Friday',
    'since March',
    'before next week',
    'Oct 20',
    '20. Oktober',
    'today and tomorrow',
    'lunch with June',
    'lunch with Jan',
    'what may happen',
    'events October to November',
    'Oktober bis Dezember',
    'on Friday',
  ])('reads no window from: %s', (phrase) => {
    expect(window(phrase)).toBeUndefined();
  });
});

describe('the other readers', () => {
  it('tells when the words say when, in any form', () => {
    expect(statesSearchDate('harbour | -15..-5', TODAY)).toBe(true);
    expect(statesSearchDate('on Friday', TODAY)).toBe(true);
    expect(statesSearchDate('Oct 20', TODAY)).toBe(true);
    expect(statesSearchDate('since March', TODAY)).toBe(true);
    expect(statesSearchDate('harbour with anna', TODAY)).toBe(false);
  });

  it('reads dates taken away', () => {
    expect(clearsSearchDates('any time')).toBe(true);
    expect(clearsSearchDates('egal wann')).toBe(true);
    expect(clearsSearchDates('harbour')).toBe(false);
  });

  it('reads the kind from plurals or "only", never from a title’s singular', () => {
    expect(searchKindOf('my tasks')).toBe('task');
    expect(searchKindOf('reminders about rent')).toBe('task');
    expect(searchKindOf('only a meeting')).toBe('event');
    expect(searchKindOf('Termine mit Anna')).toBe('event');
    expect(searchKindOf('meetings and tasks')).toBeUndefined();
    expect(searchKindOf('task review')).toBeUndefined();
    expect(searchKindOf('everything')).toBe('any');
  });

  it('reads all-day or timed', () => {
    expect(searchAllDayOf('all-day events')).toBe(true);
    expect(searchAllDayOf('timed only')).toBe(false);
    expect(searchAllDayOf('harbour')).toBeUndefined();
  });
});

describe('isSearchFilterPhrase — the router', () => {
  it.each([
    'lunch with anna',
    'harbour last month',
    'standup yesterday',
    'only tasks',
    'my reminders',
    'meetings in Vienna',
    'all-day',
    'harbour | -15..-5',
    'planning on Friday',
    'Termine mit Anna',
    'trips in October',
    'any time',
    'timed only',
  ])('reads a filter in: %s', (phrase) => {
    expect(isSearchFilterPhrase(phrase)).toBe(true);
  });

  it.each(['harbour', 'café central', 'team lunch', 'task review', 'check in'])(
    'leaves plain words plain: %s',
    (phrase) => {
      expect(isSearchFilterPhrase(phrase)).toBe(false);
    },
  );
});
