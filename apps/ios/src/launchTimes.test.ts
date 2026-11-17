import { describe, expect, it } from 'vite-plus/test';
import {
  KEPT_LAUNCHES,
  type LaunchRecord,
  launchLine,
  launchTitle,
  launchTotal,
  parseLaunches,
  reachStep,
  startLaunch,
} from './launchTimes.ts';

/** 09:23:05 UTC on some day; every time here is formatted in UTC. */
const START = Date.UTC(2026, 10, 17, 9, 23, 5);

const launch = (steps: LaunchRecord['steps'], from: LaunchRecord['from'] = 'process') => ({
  from,
  start: START,
  steps,
});

describe('startLaunch', () => {
  it('puts the new launch first with its first step counted from its start', () => {
    const older = launch({ calendar: 900, firstFrame: 600, script: 400 });
    const [newest, ...rest] = startLaunch(
      [older],
      { from: 'process', start: 1000 },
      'script',
      3900,
    );
    expect(newest).toEqual({ from: 'process', start: 1000, steps: { script: 2900 } });
    expect(rest).toEqual([older]);
  });

  it(`keeps the last ${String(KEPT_LAUNCHES)} launches`, () => {
    const full = Array.from({ length: KEPT_LAUNCHES }, (_, index) => ({
      from: 'process' as const,
      start: index,
      steps: {},
    }));
    const next = startLaunch(full, { from: 'launch', start: 99 }, 'script', 100);
    expect(next).toHaveLength(KEPT_LAUNCHES);
    expect(next[0]?.start).toBe(99);
    expect(next.at(-1)?.start).toBe(KEPT_LAUNCHES - 2);
  });

  it('never counts a step before the start (a clock set back)', () => {
    expect(startLaunch([], { from: 'process', start: 5000 }, 'script', 4000)[0]?.steps).toEqual({
      script: 0,
    });
  });
});

describe('reachStep', () => {
  it('adds the step to the newest launch only', () => {
    const older = launch({ script: 100 });
    const records = [{ ...launch({ script: 400 }), start: 1000 }, older];
    expect(reachStep(records, 'firstFrame', 1700)).toEqual([
      { from: 'process', start: 1000, steps: { firstFrame: 700, script: 400 } },
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

  it('says when the times count from the launch call of a prewarmed process', () => {
    expect(launchLine(launch({ script: 500 }, 'launch'))).toBe(
      'JavaScript 0.5 s · no first frame (prewarmed)',
    );
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
    const records = [launch({ script: 400 }), launch({ calendar: 1 }, 'launch')];
    expect(parseLaunches(JSON.stringify(records))).toEqual(records);
  });

  it('reads anything unreadable as no launches', () => {
    expect(parseLaunches('')).toEqual([]);
    expect(parseLaunches('{"from":"process"}')).toEqual([]);
    expect(parseLaunches('[{"from":"elsewhere","start":1,"steps":{}},null]')).toEqual([]);
  });
});
