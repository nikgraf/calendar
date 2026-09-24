import { AccountRepo, PendingOpRepo } from '@calendar/db';
import { Effect, Scheduler } from 'effect';
import { afterAll, beforeAll } from 'vitest';
import { SyncEngine } from '../engine.ts';
import { EventMutations } from '../mutations.ts';
import {
  LIVE_ACCOUNT_ID,
  type LiveGoogleConfig,
  LiveGoogleError,
  LiveScratch,
  type LiveScratchShape,
  makeScratchRuntime,
  scratchName,
  seedLiveAccount,
} from '../testing/liveGoogle.ts';
import { LiveScratchError } from '../testing/liveScratchRest.ts';

/**
 * Shared by the live files (`*.live.ts`, run with GOOGLE_LIVE=1): one
 * scratch calendar/list set per file, a fresh engine per test, and the
 * helpers that keep assertions date-independent and tolerant of what other
 * runs left in the account. See docs/google-sync-and-testing.md.
 */

export const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Older than this, a scratch calendar belongs to a run that never cleaned up. */
export const SWEEP_MAX_AGE_MS = 6 * HOUR;

/** A whole hour at least `hours` out — never in today's past, never a DST literal. */
export const hoursFromNow = (hours: number): number =>
  Math.ceil(Date.now() / HOUR) * HOUR + hours * HOUR;

/** `YYYY-MM-DD` `days` from now (UTC — Google task dues are date-only UTC midnight). */
export const isoDay = (days: number): string =>
  new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

/** Every title a live test writes carries the run tag, so leftovers are attributable. */
export const titleFor = (config: LiveGoogleConfig, name: string): string =>
  `live-${config.runTag}-${name}`;

export interface ScratchHandle {
  /** Ids in the order of `spec.calendars`. */
  readonly calendars: Array<string>;
  readonly lists: Array<string>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, LiveScratch>) => Promise<A>;
}

/**
 * Registers the file's beforeAll/afterAll: sweep stale leftovers, create
 * this file's calendars and lists (one calendar per file — Google
 * throttles secondary-calendar creation), delete them afterwards.
 */
export const scratchFor = (
  config: LiveGoogleConfig,
  spec: { readonly calendars?: ReadonlyArray<string>; readonly lists?: ReadonlyArray<string> },
): ScratchHandle => {
  const runtime = makeScratchRuntime(config);
  const handle: ScratchHandle = {
    calendars: [],
    lists: [],
    run: (effect) => runtime.runPromise(effect),
  };
  beforeAll(async () => {
    await handle.run(
      Effect.gen(function* () {
        const scratch = yield* LiveScratch;
        yield* scratch.sweep({ maxAgeMs: SWEEP_MAX_AGE_MS });
        for (const suffix of spec.calendars ?? []) {
          handle.calendars.push((yield* scratch.createCalendar(scratchName(config, suffix))).id);
        }
        for (const suffix of spec.lists ?? []) {
          handle.lists.push((yield* scratch.createTaskList(scratchName(config, suffix))).id);
        }
      }),
    );
  });
  afterAll(async () => {
    await handle.run(
      Effect.gen(function* () {
        const scratch = yield* LiveScratch;
        for (const id of handle.calendars) {
          yield* Effect.ignore(scratch.deleteCalendar(id));
        }
        for (const id of handle.lists) {
          yield* Effect.ignore(scratch.deleteTaskList(id));
        }
      }),
    );
    await runtime.dispose();
  });
  return handle;
};

/** Keeps the current fiber from yielding, so a detached drain cannot run in between. */
export const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

/**
 * Seeds the live account, runs the first pass and checks the token still
 * works — a dead refresh token would otherwise fail every assertion with
 * an unrelated message.
 */
export const bootstrap = (
  config: LiveGoogleConfig,
  options: { readonly contactsEnabled?: boolean } = {},
) =>
  Effect.gen(function* () {
    yield* seedLiveAccount({
      contactsEnabled: options.contactsEnabled ?? false,
      email: config.email,
      tasksEnabled: true,
    });
    const engine = yield* SyncEngine;
    const mutations = yield* EventMutations;
    const scratch = yield* LiveScratch;
    yield* engine.syncAll();
    const account = yield* (yield* AccountRepo).get(LIVE_ACCOUNT_ID);
    if (account?.status !== 'ok') {
      return yield* Effect.die(
        new Error(
          `the live account is '${account?.status}' after the first pass — the refresh token ` +
            'no longer works; mint a new one with `node scripts/google-live-token.mjs --write`',
        ),
      );
    }
    return { engine, mutations, scratch };
  });

export const pendingOps = Effect.flatMap(PendingOpRepo, (repo) => repo.listAll());

/**
 * Re-runs a pass until `check` holds: Google's `updated` stamps can lag
 * the write that set them, and the tasks watermark filters on them.
 */
export const syncUntil = <E, R>(
  engine: { readonly syncAll: () => Effect.Effect<void> },
  check: Effect.Effect<boolean, E, R>,
  tries = 4,
): Effect.Effect<boolean, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < tries; attempt++) {
      yield* engine.syncAll();
      if (yield* check) {
        return true;
      }
      yield* Effect.sleep('2 seconds');
    }
    return false;
  });

export const httpStatus = (error: LiveGoogleError): number | undefined =>
  error.cause instanceof LiveScratchError ? error.cause.status : undefined;

/**
 * How Google answers `events.get` for an event we deleted: `cancelled`
 * (the documented tombstone) or an `http 404`/`410`. Pins the answer.
 */
export const deletedStatus = (
  scratch: LiveScratchShape,
  calendarId: string,
  eventId: string,
): Effect.Effect<string> =>
  scratch.getEvent(calendarId, eventId).pipe(
    Effect.map((event) => event.status ?? 'confirmed'),
    Effect.catchTag('LiveGoogleError', (error) => Effect.succeed(`http ${httpStatus(error)}`)),
    Effect.catchTag('ReauthRequiredError', () => Effect.succeed('reauth')),
    Effect.catchTag('TokenRefreshError', () => Effect.succeed('reauth')),
  );

export const GONE = new Set(['cancelled', 'http 404', 'http 410']);
