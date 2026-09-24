#!/usr/bin/env node
/**
 * The iOS live suite's sidecar: what the Maestro flows cannot do
 * themselves. `setup` sweeps the live account, creates this run's
 * calendar and task list, mints a one-hour access token and hands all of
 * it to Maestro as `MAESTRO_LIVE_*` variables (the CLI injects every
 * `MAESTRO_*` shell variable into each flow); `teardown` deletes what
 * `setup` created. The refresh token never reaches Maestro.
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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
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
  const calendar = await createCalendar(token, calendarName);
  const list = await createTaskList(token, listName);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ calendarId: calendar.id, listId: list.id }));
  console.error(`created ${calendarName} (${calendar.id}) and ${listName} (${list.id})`);

  const vars: Record<string, string> = {
    MAESTRO_LIVE_ACCESS_TOKEN: token,
    MAESTRO_LIVE_CALENDAR_ID: calendar.id,
    MAESTRO_LIVE_CALENDAR_NAME: calendarName,
    MAESTRO_LIVE_EMAIL: live.email,
    MAESTRO_LIVE_LIST_ID: list.id,
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
  if (!existsSync(statePath)) {
    console.error(`nothing to tear down (${statePath} is missing)`);
    return;
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    calendarId?: string;
    listId?: string;
  };
  const token = await mintAccessToken(config());
  if (state.calendarId) {
    await deleteCalendar(token, state.calendarId).catch((error: unknown) => {
      console.error(`calendar ${state.calendarId} not deleted: ${String(error)}`);
    });
  }
  if (state.listId) {
    await deleteTaskList(token, state.listId).catch((error: unknown) => {
      console.error(`task list ${state.listId} not deleted: ${String(error)}`);
    });
  }
  rmSync(statePath, { force: true });
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
