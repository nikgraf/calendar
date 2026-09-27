import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveScratchError } from './liveScratchRest.ts';
import {
  allocateScratch,
  readScratchState,
  releaseScratch,
  type ScratchApi,
} from './liveScratchState.ts';

/**
 * Google as the sidecar sees it: `fail` names the calls that answer with
 * that status; created ids are `<run>-cal` and `<run>-list`.
 */
const fakeApi = (run: string, fail: Partial<Record<keyof ScratchApi, number>> = {}) => {
  const deleted: Array<string> = [];
  const answer = <A>(call: keyof ScratchApi, value: () => A): Promise<A> =>
    fail[call] === undefined
      ? Promise.resolve(value())
      : Promise.reject(new LiveScratchError(fail[call], '{"error":{}}', `https://google/${call}`));
  const api: ScratchApi = {
    createCalendar: () => answer('createCalendar', () => ({ id: `${run}-cal` })),
    createTaskList: () => answer('createTaskList', () => ({ id: `${run}-list` })),
    deleteCalendar: (_token, id) => answer('deleteCalendar', () => void deleted.push(id)),
    deleteTaskList: (_token, id) => answer('deleteTaskList', () => void deleted.push(id)),
  };
  return { api, deleted };
};

const names = { calendar: 'e2e-1-run-ios', list: 'e2e-1-run-ios-tasks' };

describe('live scratch state', () => {
  let dir: string;
  let statePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-scratch-'));
    statePath = join(dir, 'build', 'state.json');
  });
  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it('records the calendar before the list exists, so a failed setup still tears it down', async () => {
    const google = fakeApi('r1', { createTaskList: 500 });
    await expect(allocateScratch(google.api, 'token', statePath, names)).rejects.toThrow('500');
    expect(readScratchState(statePath)).toEqual({ calendars: ['r1-cal'], lists: [] });

    const teardown = fakeApi('r1');
    const { failures, left } = await releaseScratch(teardown.api, 'token', statePath);
    expect(failures).toEqual([]);
    expect(left).toEqual({ calendars: [], lists: [] });
    expect(teardown.deleted).toEqual(['r1-cal']);
    expect(existsSync(statePath)).toBe(false);
  });

  it('keeps what could not be deleted for the next teardown, and counts a 404 as gone', async () => {
    await allocateScratch(fakeApi('r1').api, 'token', statePath, names);
    const failing = fakeApi('r1', { deleteCalendar: 500, deleteTaskList: 404 });
    const first = await releaseScratch(failing.api, 'token', statePath);
    expect(first.failures).toHaveLength(1);
    expect(first.failures[0]).toContain('calendar r1-cal');
    expect(readScratchState(statePath)).toEqual({ calendars: ['r1-cal'], lists: [] });

    // The next run's setup adds its own ids next to the leftover.
    await allocateScratch(fakeApi('r2').api, 'token', statePath, names);
    expect(readScratchState(statePath)).toEqual({
      calendars: ['r1-cal', 'r2-cal'],
      lists: ['r2-list'],
    });
    const healthy = fakeApi('r2');
    const second = await releaseScratch(healthy.api, 'token', statePath);
    expect(second.failures).toEqual([]);
    expect(healthy.deleted).toEqual(['r1-cal', 'r2-cal', 'r2-list']);
    expect(existsSync(statePath)).toBe(false);
  });
});
