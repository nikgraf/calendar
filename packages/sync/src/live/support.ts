import { AccountRepo, PendingOpRepo } from '@calendar/db';
import { Effect, Scheduler } from 'effect';
import { afterAll, inject } from 'vitest';
import { SyncEngine } from '../engine.ts';
import { EventMutations } from '../mutations.ts';
import {
  LIVE_ACCOUNT_ID,
  type LiveGoogleConfig,
  LiveGoogleError,
  LiveScratch,
  type LiveScratchShape,
  makeScratchRuntime,
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
 * This run's shared scratch calendars and lists (created once by
 * globalSetup.ts — Google caps calendar creation per day), plus a scratch
 * runtime for the file's own admin calls, disposed after the file.
 */
export const scratchFor = (config: LiveGoogleConfig): ScratchHandle => {
  const runtime = makeScratchRuntime(config);
  const { calendars, lists } = inject('liveScratch');
  afterAll(async () => {
    await runtime.dispose();
  });
  return {
    calendars: [...calendars],
    lists: [...lists],
    run: (effect) => runtime.runPromise(effect),
  };
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
 * Drains the queue the way the app eventually does: Google answers a
 * burst of writes with 403 rateLimitExceeded, the op goes into backoff
 * (30 s, then 60 s), and a later drain lands it. Keeps draining until only
 * parked ops (412s waiting for a choice) are left, or two minutes passed —
 * then the assertion that follows reports what never landed.
 */
export const drain = (mutations: { readonly processPendingOps: () => Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 120_000;
    yield* mutations.processPendingOps();
    while (Date.now() < deadline) {
      const waiting = (yield* pendingOps).filter((op) => op.conflictAt === undefined);
      if (waiting.length === 0) {
        return;
      }
      yield* Effect.sleep('5 seconds');
      yield* mutations.processPendingOps();
    }
  });

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
