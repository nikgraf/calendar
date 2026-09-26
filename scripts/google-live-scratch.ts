#!/usr/bin/env node
/**
 * The iOS live suite's sidecar: what the Maestro flows cannot do
 * themselves. `setup` sweeps the live account, creates this run's
 * calendar and task list, mints a one-hour access token and hands all of
 * it to Maestro as `MAESTRO_LIVE_*` variables (the CLI injects every
 * `MAESTRO_*` shell variable into each flow); `teardown` deletes what
 * `setup` created, and exits non-zero while anything is left (the state
 * file keeps it for the next teardown). The refresh token never reaches
 * Maestro.
 *
 *   node scripts/google-live-scratch.ts setup --suffix ios [--export | --github-env]
 *   node scripts/google-live-scratch.ts teardown
 *
 * Config: GOOGLE_LIVE_REFRESH_TOKEN, GOOGLE_LIVE_EMAIL,
 * GOOGLE_DESKTOP_CLIENT_ID[/SECRET], optional GOOGLE_LIVE_RUN_TAG — or
 * the gitignored google-live.local.json + apps/desktop/google-oauth.local.json.
 * Node 24 runs this file as-is (type stripping); it shares
 * packages/sync/src/testing/liveScratchRest.ts with the Node and desktop
 * suites. See docs/google-sync-and-testing.md.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCalendar,
  createTaskList,
  deleteCalendar,
  deleteTaskList,
  mintAccessToken,
  scratchName,
  sweep,
} from '../packages/sync/src/testing/liveScratchRest.ts';
import {
  allocateScratch,
  readScratchState,
  releaseScratch,
} from '../packages/sync/src/testing/liveScratchState.ts';

const api = { createCalendar, createTaskList, deleteCalendar, deleteTaskList };

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SWEEP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const readJson = (path: string): Record<string, string> =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {};

const flags = new Map<string, string>();
const positional: Array<string> = [];
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index]!;
  if (arg.startsWith('--')) {
    const next = process.argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      index++;
    } else {
      flags.set(arg.slice(2), 'true');
    }
  } else {
    positional.push(arg);
  }
}

const statePath = flags.get('state') ?? join(ROOT, 'apps/ios/build/google-live-state.json');

const config = () => {
  const live = readJson(join(ROOT, 'google-live.local.json'));
  const oauth = readJson(join(ROOT, 'apps/desktop/google-oauth.local.json'));
  const refreshToken = process.env['GOOGLE_LIVE_REFRESH_TOKEN'] || live['refreshToken'];
  const email = process.env['GOOGLE_LIVE_EMAIL'] || live['email'];
  const clientId = process.env['GOOGLE_DESKTOP_CLIENT_ID'] || oauth['clientId'];
  const clientSecret = process.env['GOOGLE_DESKTOP_CLIENT_SECRET'] || oauth['clientSecret'];
  if (!refreshToken || !email || !clientId) {
    console.error(
      'missing GOOGLE_LIVE_REFRESH_TOKEN / GOOGLE_LIVE_EMAIL / GOOGLE_DESKTOP_CLIENT_ID ' +
        '(or google-live.local.json + apps/desktop/google-oauth.local.json); ' +
        'run `node scripts/google-live-token.mjs --write` once',
    );
    process.exit(2);
  }
  return {
    clientId,
    clientSecret: clientSecret || undefined,
    email,
    refreshToken,
    runTag: process.env['GOOGLE_LIVE_RUN_TAG'] || `local-${process.pid}`,
  };
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

const setup = async (): Promise<void> => {
  const live = config();
  const suffix = flags.get('suffix') ?? 'ios';
  const token = await mintAccessToken(live);
  const swept = await sweep(token, { maxAgeMs: SWEEP_MAX_AGE_MS });
  console.error(`swept ${swept.calendars} stale calendars, ${swept.lists} stale lists`);
  const calendarName = scratchName(live.runTag, suffix);
  const listName = scratchName(live.runTag, `${suffix}-tasks`);
  // Each id lands in the state file as soon as it exists, so a setup that
  // dies halfway still leaves teardown something to delete.
  const { calendarId, listId } = await allocateScratch(api, token, statePath, {
    calendar: calendarName,
    list: listName,
  });
  console.error(`created ${calendarName} (${calendarId}) and ${listName} (${listId})`);

  const vars: Record<string, string> = {
    MAESTRO_LIVE_ACCESS_TOKEN: token,
    MAESTRO_LIVE_CALENDAR_ID: calendarId,
    MAESTRO_LIVE_CALENDAR_NAME: calendarName,
    MAESTRO_LIVE_EMAIL: live.email,
    MAESTRO_LIVE_LIST_ID: listId,
    MAESTRO_LIVE_LIST_NAME: listName,
    MAESTRO_LIVE_RUN_TAG: live.runTag,
  };
  const githubEnv = process.env['GITHUB_ENV'];
  if (flags.has('github-env') && githubEnv) {
    // The token must never show in the job log.
    console.log(`::add-mask::${token}`);
    appendFileSync(
      githubEnv,
      Object.entries(vars)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
    console.error(`exported ${Object.keys(vars).length} MAESTRO_LIVE_* variables to GITHUB_ENV`);
    return;
  }
  for (const [key, value] of Object.entries(vars)) {
    console.log(flags.has('export') ? `export ${key}=${shellQuote(value)}` : `${key}=${value}`);
  }
};

const teardown = async (): Promise<void> => {
  const state = readScratchState(statePath);
  if (state.calendars.length === 0 && state.lists.length === 0) {
    console.error(`nothing to tear down (${statePath} records nothing)`);
    return;
  }
  const { failures } = await releaseScratch(api, await mintAccessToken(config()), statePath);
  if (failures.length > 0) {
    // Red, not "torn down": a leaked calendar counts against Google's daily
    // creation cap. The ids stay in the state file for the next teardown.
    console.error(`not deleted (kept in ${statePath}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.error('torn down');
};

const command = positional[0];
const run = command === 'setup' ? setup : command === 'teardown' ? teardown : undefined;
if (!run) {
  console.error(
    'usage: google-live-scratch.ts setup [--suffix <s>] [--export | --github-env] | teardown',
  );
  process.exit(2);
}
try {
  await run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
