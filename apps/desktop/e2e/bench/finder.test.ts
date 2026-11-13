import { join } from 'node:path';
import type { FindTimeResult } from '@calendar/ai';
import { describe, expect, it } from 'vite-plus/test';
import {
  checkFinder,
  datesSearched,
  expectedBounds,
  expectedWindows,
  type FinderExpectation,
  loadFinderCases,
} from './finder.ts';

// A Friday; every date below is relative to it, passed in, never read from the clock.
const FRIDAY = '2026-11-13';

const parsed = (
  constraints: Partial<Extract<FindTimeResult, { kind: 'parsed' }>['constraints']>,
  title?: string,
): FindTimeResult => ({
  constraints: {
    durationMinutes: 60,
    windowEndDate: '2026-11-19',
    windowStartDate: FRIDAY,
    ...constraints,
  },
  kind: 'parsed',
  ...(title === undefined ? {} : { title }),
});

const expectation = (overrides: Partial<FinderExpectation>): FinderExpectation => ({
  bounds: null,
  days: null,
  duration: 'default',
  title: null,
  window: 'default',
  ...overrides,
});

describe('loadFinderCases', () => {
  it('reads every case in finder.json, each id once', () => {
    const cases = loadFinderCases(join(import.meta.dirname, 'finder.json'));
    expect(cases.length).toBeGreaterThan(30);
    expect(new Set(cases.map((finderCase) => finderCase.id)).size).toBe(cases.length);
  });
});

describe('expectedWindows', () => {
  it('names a window relative to the day the bench runs on', () => {
    const one = (window: FinderExpectation['window']) => expectedWindows(window, FRIDAY);
    expect(one('default')).toEqual([{ windowEndDate: '2026-11-19', windowStartDate: FRIDAY }]);
    expect(one('today')).toEqual([{ windowEndDate: FRIDAY, windowStartDate: FRIDAY }]);
    expect(one('dayAfterTomorrow')).toEqual([
      { windowEndDate: '2026-11-15', windowStartDate: '2026-11-15' },
    ]);
    // This week ends on the coming Sunday; next week is Monday to Sunday after it.
    expect(one('thisWeek')).toEqual([{ windowEndDate: '2026-11-15', windowStartDate: FRIDAY }]);
    expect(one('nextWeek')).toEqual([
      { windowEndDate: '2026-11-22', windowStartDate: '2026-11-16' },
    ]);
    expect(one('fortnight')).toEqual([{ windowEndDate: '2026-11-26', windowStartDate: FRIDAY }]);
    // A weekday is the coming one; today's may mean today or a week on.
    expect(one({ weekday: 4 })).toEqual([
      { windowEndDate: '2026-11-19', windowStartDate: '2026-11-19' },
    ]);
    expect(one({ weekday: 5 }).map((window) => window.windowStartDate)).toEqual([
      FRIDAY,
      '2026-11-20',
    ]);
    // The weekend: the coming one; begun, what is left of it or the next.
    expect(one('weekend')).toEqual([
      { windowEndDate: '2026-11-15', windowStartDate: '2026-11-14' },
    ]);
    expect(expectedWindows('weekend', '2026-11-15')).toEqual([
      { windowEndDate: '2026-11-15', windowStartDate: '2026-11-15' },
      { windowEndDate: '2026-11-22', windowStartDate: '2026-11-21' },
    ]);
    expect(expectedWindows('weekend', '2026-11-14')[0]).toEqual({
      windowEndDate: '2026-11-15',
      windowStartDate: '2026-11-14',
    });
  });
});

describe('datesSearched and expectedBounds', () => {
  it('lists the window’s days on the weekdays, and a period by its window', () => {
    const week = { windowEndDate: '2026-11-19', windowStartDate: FRIDAY };
    expect(datesSearched(week, [6, 7])).toBe('2026-11-14,2026-11-15');
    expect(datesSearched(week, undefined).split(',')).toHaveLength(7);
    expect(datesSearched(week, [8])).toBe('-');
    expect(expectedBounds({ period: 'morning' })).toEqual([
      { earliestTime: '08:00', latestTime: '12:00' },
    ]);
    expect(expectedBounds({ earliest: '17:00' })).toEqual([{ earliestTime: '17:00' }]);
    expect(expectedBounds([{ earliest: '13:00' }, { period: 'afternoon' }])).toEqual([
      { earliestTime: '13:00' },
      { earliestTime: '12:00', latestTime: '17:00' },
    ]);
    expect(expectedBounds(null)).toEqual([{}]);
  });
});

describe('checkFinder', () => {
  it('passes an answer that searches what the case means', () => {
    const check = checkFinder(
      expectation({
        bounds: { period: 'morning' },
        duration: 90,
        title: ['focus'],
        window: 'nextWeek',
      }),
      parsed(
        {
          durationMinutes: 90,
          earliestTime: '08:00',
          latestTime: '12:00',
          windowEndDate: '2026-11-22',
          windowStartDate: '2026-11-16',
        },
        'Focus',
      ),
      FRIDAY,
    );
    expect(check.failed).toEqual([]);
    expect(check.got).toEqual({
      bounds: '08:00–12:00',
      dates: '2026-11-16..2026-11-22',
      duration: '90',
      title: 'Focus',
    });
  });

  it('takes a weekday as its own window or as the week on that weekday', () => {
    const wednesday = expectation({ window: { weekday: 3 } });
    const asWindow = parsed({ windowEndDate: '2026-11-18', windowStartDate: '2026-11-18' });
    const asWeekday = parsed({ daysOfWeek: [3] });
    expect(checkFinder(wednesday, asWindow, FRIDAY).failed).toEqual([]);
    expect(checkFinder(wednesday, asWeekday, FRIDAY).failed).toEqual([]);
    expect(checkFinder(wednesday, parsed({ daysOfWeek: [4] }), FRIDAY).failed).toEqual(['dates']);
  });

  it('holds what the words left out to the finder’s own: its length, its window, no bounds or title', () => {
    expect(checkFinder(expectation({}), parsed({}), FRIDAY).failed).toEqual([]);
    expect(
      checkFinder(
        expectation({}),
        parsed({ durationMinutes: 30, earliestTime: '09:00' }, 'Meeting'),
        FRIDAY,
      ).failed,
    ).toEqual(['duration', 'bounds', 'title']);
  });

  it('scores bounds as the solver searches them, its daytime filling an unset end', () => {
    const beforeTen = expectation({ bounds: { latest: '10:00' } });
    expect(checkFinder(beforeTen, parsed({ latestTime: '10:00' }), FRIDAY).failed).toEqual([]);
    expect(
      checkFinder(beforeTen, parsed({ earliestTime: '08:00', latestTime: '10:00' }), FRIDAY).failed,
    ).toEqual([]);
    expect(checkFinder(beforeTen, parsed({ latestTime: '11:00' }), FRIDAY).failed).toEqual([
      'bounds',
    ]);
    // Any of the readings a case lists.
    const afterLunch = expectation({ bounds: [{ earliest: '13:00' }, { earliest: '14:00' }] });
    expect(checkFinder(afterLunch, parsed({ earliestTime: '14:00' }), FRIDAY).failed).toEqual([]);
  });

  it('accepts no title where a case lists "", and any length unsaid for the raw arm', () => {
    const lunch = expectation({ title: ['', 'lunch'] });
    expect(checkFinder(lunch, parsed({}), FRIDAY).failed).toEqual([]);
    expect(checkFinder(lunch, parsed({}, 'Lunch'), FRIDAY).failed).toEqual([]);
    expect(checkFinder(lunch, parsed({}, 'Meeting'), FRIDAY).failed).toEqual(['title']);
    const unsaid = parsed({ durationMinutes: 90 });
    expect(checkFinder(expectation({}), unsaid, FRIDAY).failed).toEqual(['duration']);
    expect(checkFinder(expectation({}), unsaid, FRIDAY, { anyLengthUnsaid: true }).failed).toEqual(
      [],
    );
    expect(
      checkFinder(expectation({ duration: 45 }), unsaid, FRIDAY, { anyLengthUnsaid: true }).failed,
    ).toEqual(['duration']);
  });

  it('gets every part wrong for a refused answer', () => {
    const check = checkFinder(
      expectation({}),
      { kind: 'rejected', reason: 'Say how long you need — e.g. "90 min".' },
      FRIDAY,
    );
    expect(check.failed).toEqual(['duration', 'dates', 'bounds', 'title']);
    expect(check.got.duration).toContain('refused');
  });
});
