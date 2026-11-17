import { describe, expect, it } from 'vite-plus/test';
import {
  addLaunch,
  KEPT_LAUNCHES,
  type LaunchRecord,
  launchLine,
  launchTitle,
  launchTotal,
  parseLaunches,
  reachStep,
} from './launchTimes.ts';

/** 09:23:05 UTC on some day; every time here is formatted in UTC. */
const START = Date.UTC(2026, 10, 17, 9, 23, 5);

const launch = (steps: LaunchRecord['steps']): LaunchRecord => ({ start: START, steps });

describe('addLaunch', () => {
  it('puts the new launch first, no step reached yet', () => {
    const older = launch({ calendar: 900, firstFrame: 600, script: 400 });
    expect(addLaunch([older], 1000)).toEqual([{ start: 1000, steps: {} }, older]);
  });

  it(`keeps the last ${String(KEPT_LAUNCHES)} launches`, () => {
    const full = Array.from({ length: KEPT_LAUNCHES }, (_, index) => ({ start: index, steps: {} }));
    const next = addLaunch(full, 99);
    expect(next).toHaveLength(KEPT_LAUNCHES);
    expect(next[0]?.start).toBe(99);
    expect(next.at(-1)?.start).toBe(KEPT_LAUNCHES - 2);
  });

  it('keeps a launch closed before its JavaScript ran under the one that found it', () => {
    const next = reachStep(addLaunch(addLaunch([], 1000), 5000), 'script', 5400);
    expect(next).toEqual([
      { start: 5000, steps: { script: 400 } },
      { start: 1000, steps: {} },
    ]);
    expect(next.map(launchLine)).toEqual(['JavaScript 0.4 s · no first frame', 'no JavaScript']);
  });
});

describe('reachStep', () => {
  it('adds the step to the newest launch only', () => {
    const older = launch({ script: 100 });
    const records = [{ ...launch({ script: 400 }), start: 1000 }, older];
    expect(reachStep(records, 'firstFrame', 1700)).toEqual([
      { start: 1000, steps: { firstFrame: 700, script: 400 } },
      older,
    ]);
  });

  it('keeps the first time a step was reached', () => {
    const records = [launch({ firstFrame: 600, script: 400 })];
    expect(reachStep(records, 'firstFrame', START + 5000)).toBe(records);
  });

  it('does nothing without a launch', () => {
    expect(reachStep([], 'calendar', 1)).toEqual([]);
  });

  it('never counts a step before the start (a clock set back)', () => {
    expect(reachStep(addLaunch([], 5000), 'script', 4000)[0]?.steps).toEqual({ script: 0 });
  });
});

describe('launchLine', () => {
  it('reads every step of a launch that drew the calendar', () => {
    expect(launchLine(launch({ calendar: 3600, firstFrame: 3200, script: 2900 }))).toBe(
      'JavaScript 2.9 s · first frame 3.2 s · calendar 3.6 s',
    );
  });

  it('ends at the first step a launch never reached', () => {
    expect(launchLine(launch({ script: 14_200 }))).toBe('JavaScript 14.2 s · no first frame');
    expect(launchLine(launch({}))).toBe('no JavaScript');
  });
});

describe('launchTotal', () => {
  it('is the time to the calendar, or a dash for a launch that never drew it', () => {
    expect(launchTotal(launch({ calendar: 3649, firstFrame: 3200, script: 2900 }))).toBe('3.6 s');
    expect(launchTotal(launch({ script: 2900 }))).toBe('—');
  });
});

describe('launchTitle', () => {
  it('names the day and the time to the second', () => {
    expect(launchTitle(launch({}), 'UTC')).toBe('Nov 17, 9:23:05 AM');
  });
});

describe('parseLaunches', () => {
  it('reads back what was written', () => {
    const records = [launch({ script: 400 }), { start: 1, steps: {} }];
    expect(parseLaunches(JSON.stringify(records))).toEqual(records);
  });

  it('reads anything unreadable as no launches', () => {
    expect(parseLaunches('')).toEqual([]);
    expect(parseLaunches('{"start":1,"steps":{}}')).toEqual([]);
    expect(parseLaunches('[{"start":"1","steps":{}},{"start":1},null]')).toEqual([]);
  });
});
