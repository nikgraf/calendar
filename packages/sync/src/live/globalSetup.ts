import type { TestProject } from 'vitest/node';
import { liveGoogleConfigFromEnv, scratchName } from '../testing/liveGoogle.ts';
import {
  createCalendar,
  createTaskList,
  deleteCalendar,
  deleteTaskList,
  mintAccessToken,
  sweep,
} from '../testing/liveScratchRest.ts';

/**
 * One set of scratch resources per Node run (GOOGLE_LIVE=1), shared by
 * every live file: Google caps calendar creation per account and day
 * ("Calendar usage limits exceeded" after ~40 on a debugging day), so a
 * calendar per file did not scale. Files run one at a time and assert only
 * on their own ids and run-tagged titles, so sharing is safe; overlapping
 * runs still never share, each has its own `e2e-<ts>-<runTag>` set.
 */

export interface LiveScratchIds {
  /** [main, second] — the second is the move destination. */
  readonly calendars: readonly [string, string];
  readonly lists: readonly [string, string];
}

declare module 'vitest' {
  interface ProvidedContext {
    liveScratch: LiveScratchIds;
  }
}

const SWEEP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const config = liveGoogleConfigFromEnv();
  const token = () => mintAccessToken(config);
  const first = await token();
  await sweep(first, { maxAgeMs: SWEEP_MAX_AGE_MS });
  const created: { calendars: Array<string>; lists: Array<string> } = { calendars: [], lists: [] };
  const cleanUp = async () => {
    // A fresh token: the run may have outlived the first one.
    const last = await token();
    for (const id of created.calendars) {
      await deleteCalendar(last, id).catch(() => undefined);
    }
    for (const id of created.lists) {
      await deleteTaskList(last, id).catch(() => undefined);
    }
  };
  try {
    for (const suffix of ['node', 'node-2']) {
      created.calendars.push((await createCalendar(first, scratchName(config, suffix))).id);
    }
    for (const suffix of ['node-tasks', 'node-tasks-2']) {
      created.lists.push((await createTaskList(first, scratchName(config, suffix))).id);
    }
  } catch (error) {
    await cleanUp();
    throw error;
  }
  project.provide('liveScratch', {
    calendars: [created.calendars[0]!, created.calendars[1]!],
    lists: [created.lists[0]!, created.lists[1]!],
  });
  return cleanUp;
}
