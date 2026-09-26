/**
 * The iOS sidecar's record of what it created on the live account: a JSON
 * state file that `setup` writes after *each* creation and `teardown`
 * empties as deletions succeed. A setup that dies after creating the
 * calendar therefore still leaves it for teardown, and a deletion that
 * fails stays recorded for the next teardown instead of leaking until the
 * six-hour sweep (Google caps calendar creation per day).
 *
 * Effect-free and free of workspace imports on purpose: Node 24 runs this
 * file as-is (type stripping) for `scripts/google-live-scratch.ts`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LiveScratchError } from './liveScratchRest.ts';

export interface ScratchIds {
  readonly calendars: ReadonlyArray<string>;
  readonly lists: ReadonlyArray<string>;
}

/** The admin calls, injectable so the failure paths can be tested offline. */
export interface ScratchApi {
  readonly createCalendar: (token: string, summary: string) => Promise<{ readonly id: string }>;
  readonly createTaskList: (token: string, title: string) => Promise<{ readonly id: string }>;
  readonly deleteCalendar: (token: string, calendarId: string) => Promise<void>;
  readonly deleteTaskList: (token: string, listId: string) => Promise<void>;
}

const EMPTY: ScratchIds = { calendars: [], lists: [] };

export const readScratchState = (statePath: string): ScratchIds => {
  if (!existsSync(statePath)) {
    return EMPTY;
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<ScratchIds>;
  return { calendars: state.calendars ?? [], lists: state.lists ?? [] };
};

const writeScratchState = (statePath: string, ids: ScratchIds): void => {
  if (ids.calendars.length === 0 && ids.lists.length === 0) {
    rmSync(statePath, { force: true });
    return;
  }
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(ids));
};

const record = (statePath: string, add: Partial<ScratchIds>): void => {
  const state = readScratchState(statePath);
  writeScratchState(statePath, {
    calendars: [...state.calendars, ...(add.calendars ?? [])],
    lists: [...state.lists, ...(add.lists ?? [])],
  });
};

/**
 * Creates the run's calendar and task list, recording each id in
 * `statePath` as soon as Google returned it. Ids an earlier teardown could
 * not delete stay recorded next to them.
 */
export const allocateScratch = async (
  api: ScratchApi,
  token: string,
  statePath: string,
  names: { readonly calendar: string; readonly list: string },
): Promise<{ readonly calendarId: string; readonly listId: string }> => {
  const calendar = await api.createCalendar(token, names.calendar);
  record(statePath, { calendars: [calendar.id] });
  const list = await api.createTaskList(token, names.list);
  record(statePath, { lists: [list.id] });
  return { calendarId: calendar.id, listId: list.id };
};

const gone = (error: unknown): boolean =>
  error instanceof LiveScratchError && (error.status === 404 || error.status === 410);

/**
 * Deletes everything `statePath` records. Already gone counts as deleted;
 * what could not be deleted stays recorded and is returned, with why.
 */
export const releaseScratch = async (
  api: ScratchApi,
  token: string,
  statePath: string,
): Promise<{ readonly failures: ReadonlyArray<string>; readonly left: ScratchIds }> => {
  const state = readScratchState(statePath);
  const failures: Array<string> = [];
  const attempt = async (
    ids: ReadonlyArray<string>,
    remove: (token: string, id: string) => Promise<void>,
    what: string,
  ): Promise<ReadonlyArray<string>> => {
    const left: Array<string> = [];
    for (const id of ids) {
      try {
        await remove(token, id);
      } catch (error) {
        if (!gone(error)) {
          left.push(id);
          failures.push(`${what} ${id}: ${String(error)}`);
        }
      }
    }
    return left;
  };
  const left: ScratchIds = {
    calendars: await attempt(state.calendars, api.deleteCalendar, 'calendar'),
    lists: await attempt(state.lists, api.deleteTaskList, 'task list'),
  };
  writeScratchState(statePath, left);
  return { failures, left };
};
