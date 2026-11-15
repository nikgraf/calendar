import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FindTimeResult } from '@calendar/ai';
import { describe, expect, it } from 'vite-plus/test';
import {
  checkFinder,
  compareFinderReports,
  datesSearched,
  expectedBounds,
  expectedWindows,
  type FinderCase,
  type FinderExpectation,
  type FinderReport,
  formatFinderReport,
  loadFinderCases,
  readAnswer,
  rescoreFinder,
  scoreOf,
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

describe('loadFinderCases, refusing a case', () => {
  it('whose bound is left open beyond the solver’s daytime', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'finder-cases-')), 'finder.json');
    const late = {
      expect: {
        bounds: { earliest: '21:00' },
        days: null,
        duration: 60,
        title: null,
        window: 'today',
      },
      id: 'late',
      lang: 'en',
      text: 'Find an hour after 9pm',
    };
    writeFileSync(path, JSON.stringify([late]));
    expect(() => loadFinderCases(path)).toThrow('name both ends');
    writeFileSync(
      path,
      JSON.stringify([
        { ...late, expect: { ...late.expect, bounds: { earliest: '21:00', latest: '23:00' } } },
      ]),
    );
    expect(loadFinderCases(path)).toHaveLength(1);
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

  it('counts the dates from today on: the solver offers no slot in the past', () => {
    // "this week" as Monday to Sunday, asked on a Friday, searches Friday to Sunday.
    const thisWeek = expectation({ window: 'thisWeek' });
    const mondayToSunday = parsed({ windowEndDate: '2026-11-15', windowStartDate: '2026-11-09' });
    expect(checkFinder(thisWeek, mondayToSunday, FRIDAY).failed).toEqual([]);
    // A window wholly past searches nothing.
    const lastWeek = parsed({ windowEndDate: '2026-11-08', windowStartDate: '2026-11-02' });
    expect(checkFinder(thisWeek, lastWeek, FRIDAY).failed).toEqual(['dates']);
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

describe('readAnswer and rescoreFinder', () => {
  const unsaid: FinderCase = {
    expect: expectation({}),
    id: 'unsaid',
    lang: 'en',
    text: 'Find some time',
  };

  it('fills a length the model left out with the finder’s own, without the rules too', () => {
    const arms = readAnswer({}, unsaid, FRIDAY);
    expect(arms.rules.failed).toEqual([]);
    expect(arms.raw.failed).toEqual([]);
    // Something that is no answer is refused in both arms.
    expect(readAnswer(undefined, unsaid, FRIDAY).raw.failed).toHaveLength(4);
  });

  it('holds the Assistant’s own model to leaving an unsaid length out', () => {
    const length = { durationMinutes: 30 };
    expect(readAnswer(length, unsaid, FRIDAY).raw.failed).toEqual([]);
    expect(readAnswer(length, unsaid, FRIDAY, { pipeline: 'tuned' }).raw.failed).toEqual([
      'duration',
    ]);
    expect(readAnswer({}, unsaid, FRIDAY, { pipeline: 'tuned' }).raw.failed).toEqual([]);
    // Read as the app reads it: a length of nothing is none.
    expect(
      readAnswer({ durationMinutes: 0 }, unsaid, FRIDAY, { pipeline: 'tuned' }).raw.failed,
    ).toEqual([]);
  });

  it('names the run it came from however often it is scored again, and the cases left out', () => {
    const cases = [
      {
        answer: {},
        arms: readAnswer({}, unsaid, FRIDAY),
        id: 'unsaid',
        lang: 'en',
        ms: 1,
        prompt: 'p',
        text: unsaid.text,
      },
    ];
    const run: FinderReport = {
      cases: [...cases, { ...cases[0]!, id: 'gone' }],
      provider: 'apple',
      score: scoreOf(cases),
      sha: 'aaaa1111',
      timeZone: 'Europe/Vienna',
      today: FRIDAY,
      when: '2026-11-13T10:00:00.000Z',
    };
    const once = rescoreFinder(run, [unsaid], {
      sha: 'bbbb2222',
      when: '2026-11-14T10:00:00.000Z',
    });
    expect(once.left).toEqual(['gone']);
    expect(once.report.rescored).toEqual({ left: ['gone'], sha: 'aaaa1111', when: run.when });
    expect(once.report.score.total).toBe(1);
    const twice = rescoreFinder(once.report, [unsaid], {
      sha: 'cccc3333',
      when: '2026-11-15T10:00:00.000Z',
    });
    expect(twice.report.rescored).toMatchObject({ sha: 'aaaa1111', when: run.when });
    expect(twice.report.sha).toBe('cccc3333');
  });
});

const answered = (finderCase: FinderCase, answer: unknown) => ({
  answer,
  arms: readAnswer(answer, finderCase, FRIDAY),
  blind: finderCase.blind === true,
  id: finderCase.id,
  lang: 'en',
  ms: 400,
  prompt: 'p',
  text: finderCase.text,
});
const reportOf = (
  cases: FinderReport['cases'],
  over: Partial<FinderReport> = {},
): FinderReport => ({
  cases,
  provider: 'openai:assistant-v2',
  score: scoreOf(cases),
  sha: 'aaaa1111',
  timeZone: 'Europe/Vienna',
  today: FRIDAY,
  when: '2026-11-13T10:00:00.000Z',
  ...over,
});

describe('formatFinderReport and compareFinderReports', () => {
  const walk: FinderCase = {
    expect: expectation({ title: ['walk'] }),
    id: 'walk',
    lang: 'en',
    text: 'Find time for a walk',
  };
  const sealed: FinderCase = { ...walk, blind: true, id: 'sealed', text: 'Time for a walk?' };
  const right = { title: 'Walk' };
  const wrong = { title: 'Find time' };

  it('prints each arm’s score and every case an arm got wrong', () => {
    const text = formatFinderReport(
      reportOf([answered(walk, wrong), answered({ ...walk, id: 'walk-2' }, right)]),
    );
    expect(text).toContain('== openai:assistant-v2');
    expect(text).toContain('   median 0.4s per phrase');
    expect(text).toContain(
      '   raw    cases 1/2 · duration 2/2 · dates 2/2 · bounds 2/2 · title 1/2',
    );
    expect(text).toContain('   ✗ walk  "Find time for a walk"');
    expect(text).toContain('       raw: title=');
    expect(text).not.toContain('walk-2');
    // No blind case: nothing about sets.
    expect(text).not.toContain('   open ');
  });

  it('counts a blind case in every score and gives it no line of its own', () => {
    const report = reportOf([answered(walk, right), answered(sealed, wrong)]);
    const text = formatFinderReport(report);
    expect(text).not.toContain('sealed');
    expect(text).not.toContain('Time for a walk?');
    expect(text).toContain('   raw    cases 1/2');
    expect(text).toContain(
      '   open  raw    cases 1/1 · duration 1/1 · dates 1/1 · bounds 1/1 · title 1/1',
    );
    expect(text).toContain(
      '   blind raw    cases 0/1 · duration 1/1 · dates 1/1 · bounds 1/1 · title 0/1',
    );
    expect(formatFinderReport(report, { showBlind: true })).toContain(
      '   ✗ sealed (blind)  "Time for a walk?"',
    );
  });

  it('compares two runs arm by arm, a blind flip counted and not named', () => {
    const before = reportOf([answered(walk, wrong), answered(sealed, wrong)], {
      sha: 'old0000',
      when: '2026-11-12T09:00:00.000Z',
    });
    const after = reportOf([answered(walk, right), answered(sealed, right)], {
      pipeline: 'tuned',
    });
    const text = compareFinderReports(before, after);
    expect(text).toContain('   vs old0000 (2026-11-12T09:00): rules 0/2 → 2/2, raw 0/2 → 2/2');
    expect(text).toContain('   asked differently: app → tuned');
    expect(text).toContain('   raw:\n   fixed: walk · 1 blind');
    expect(text).toContain('2 fixed, 0 broke: by chance alone p = 0.50');
    expect(text).not.toContain('sealed');
    // Nothing moved: only the line that names the earlier run.
    expect(compareFinderReports(before, before).split('\n')).toHaveLength(1);
  });

  it('leaves a reworded sentence out of the flips', () => {
    const before = reportOf([answered(walk, wrong), answered(sealed, wrong)]);
    const reworded = { ...walk, text: 'Find an hour for a walk' };
    const after = reportOf([answered(reworded, right), answered(sealed, right)]);
    const text = compareFinderReports(before, after);
    expect(text).toContain('   not compared (other words in the two runs): walk');
    // Only the blind case, read in the same words, is a flip.
    expect(text).toContain('   raw:\n   fixed: 1 blind');
    expect(text).not.toContain('fixed: walk');
    expect(text).toContain('1 fixed, 0 broke');
  });

  it('says when two runs were not set up alike or read on two days', () => {
    const before = reportOf([answered(walk, right)], { settings: 'http://localhost:8091/v1' });
    const after = reportOf([answered(walk, right)], {
      settings: 'http://localhost:8093/v1',
      today: '2026-11-18',
    });
    const text = compareFinderReports(before, after);
    expect(text).toContain('   settings: http://localhost:8091/v1 → http://localhost:8093/v1');
    expect(text).toContain('   read on two days, 2026-11-13 → 2026-11-18');
  });

  it('warns that a weekend day leaves "this week" without weekdays', () => {
    const friday = reportOf([answered(walk, right)]);
    expect(formatFinderReport(friday)).not.toContain('weekend day');
    expect(formatFinderReport({ ...friday, today: '2026-11-15' })).toContain(
      '   read on a weekend day: "this week" has no weekday left',
    );
  });

  it('scores a report again with the cases’ blind flags as they are now', () => {
    const run = reportOf([{ ...answered(walk, right), blind: undefined }]);
    const { report } = rescoreFinder(run, [{ ...walk, blind: true }], {
      sha: 'bbbb2222',
      when: '2026-11-14T10:00:00.000Z',
    });
    expect(report.cases[0]?.blind).toBe(true);
  });
});
