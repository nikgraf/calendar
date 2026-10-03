import { AppleCalendarClient, type AppleCalendarClientShape } from '@calendar/apple-calendar';
import {
  APPLE_DEFAULT_SOURCE,
  buildMirrorCopies,
  MIRROR_MAX_MONTHS,
  type MirrorCalendarRef,
  type MirrorDefinition,
  type MirrorOp,
  type MirrorPreview,
  type MirrorReason,
  type MirrorStatus,
  mirrorTag,
  mirrorRefKey,
  type MirrorView,
  mirrorWindow,
  msUntilNextMidnight,
  planMirror,
} from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  DeviceSettingsRepo,
  EventRepo,
  PendingOpRepo,
  SyncStateRepo,
  TaskRepo,
} from '@calendar/db';
import {
  ACCOUNTS_KEY,
  CALENDARS_KEY,
  deviceSettingsKey,
  EVENTS_KEY,
  SYNC_STATE_KEY,
  TASKLISTS_KEY,
  TASKS_KEY,
} from '@calendar/db/keys';
import { GoogleCalendarClient, grantsCalendarCreation, TokenStore } from '@calendar/google';
import { Clock, Context, Duration, Effect, Layer, Schema, Semaphore, Stream } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SyncEngine } from './engine.ts';
import {
  appleMirrorDestination,
  googleMirrorDestination,
  type MirrorDestination,
} from './mirrorDestination.ts';
import {
  type MirrorBlock,
  mirrorGate,
  resolveMirror,
  resolveMirrorDestination,
  type ResolvedCalendar,
} from './mirrorResolve.ts';
import {
  DEFAULT_MIRROR_LOCAL,
  type MirrorLocal,
  MIRRORS_KEY,
  MirrorSaveError,
  mirrorStatusOf,
  readMirrorLocals,
  readMirrors,
  removeMirror,
  saveMirror,
  updateMirrorLocal,
} from './mirrorSettings.ts';
import { loadMirrorItems } from './mirrorSources.ts';

/**
 * Keeps every mirror's destination in step with its sources. A run is a
 * reconcile: what should exist is computed from the sources, what exists
 * is read from the destination, and the difference is written. Nothing is
 * remembered about which copy belongs to which source — the destination
 * is the state — so any device can run a mirror, a run that was cut off
 * simply runs again, and two devices running the same mirror agree.
 *
 * Its own service, like LocalNotifications: the engine stays free of it,
 * and it reacts to what the engine and the user change.
 */

/** A source lost this share of its copies at once: hold on before believing it. */
const LARGE_REMOVAL_SHARE = 0.3;
const LARGE_REMOVAL_MIN = 10;
/** How long a large removal waits. EventKit never says whether iCloud has caught up. */
const LARGE_REMOVAL_WAIT_MS = 10 * 60_000;
/** The same write made this many times within a day means something keeps undoing it. */
const REWRITE_LIMIT = 3;
const JOURNAL_WINDOW_MS = 24 * 60 * 60_000;
/** A plan is acted on for this long, then made again from fresh reads. */
const PLAN_LIFETIME_MS = 60_000;
/** Writes per plan: one Apple batch, a minute of paced Google writes. */
const WRITES_PER_PLAN = 200;
const DAY_MS = 24 * 60 * 60_000;
const CHANGE_DEBOUNCE = '3 seconds';
const HEARTBEAT_MS = 30 * 60_000;

/** Reasons that clear by themselves; the rest need the user. */
const WAITING: ReadonlySet<MirrorReason> = new Set<MirrorReason>([
  'accountSignedOut',
  'appleUnavailable',
  'destinationMissing',
  'error',
  'largeRemoval',
  'sourceMissing',
  'syncing',
  'unsyncedChanges',
]);

export class MirrorCalendarError extends Schema.Error<MirrorCalendarError>(
  'sync/MirrorCalendarError',
)({
  message: Schema.String,
  /** 'needsSignIn': the Google account was signed in before the app asked to create calendars. */
  reason: Schema.Literals(['failed', 'needsSignIn']),
}) {}

export interface MirrorsShape {
  /** A new calendar to mirror into: in a Google account, or in the device's default Apple account. */
  readonly createCalendar: (
    target:
      | { readonly accountId: string; readonly kind: 'google'; readonly title: string }
      | { readonly kind: 'apple'; readonly title: string },
  ) => Effect.Effect<MirrorCalendarRef, MirrorCalendarError>;
  readonly list: () => Effect.Effect<ReadonlyArray<MirrorView>>;
  /** What a definition would write, saved or not. Reads only. */
  readonly preview: (definition: MirrorDefinition) => Effect.Effect<MirrorPreview>;
  /**
   * Forgets a mirror on this device, first deleting its copies from the
   * destination when asked. Another device that still runs the mirror
   * will write them again.
   */
  readonly remove: (id: string, removeCopies: boolean) => Effect.Effect<void, MirrorSaveError>;
  /**
   * One pass over every mirror. `force` skips the large-removal wait (the
   * user's "Run now"); `budget` bounds the pass for a background launch.
   * Never fails.
   */
  readonly run: (options?: {
    readonly budget?: Duration.Input | undefined;
    readonly force?: boolean | undefined;
  }) => Effect.Effect<void>;
  readonly save: (definition: MirrorDefinition) => Effect.Effect<MirrorView, MirrorSaveError>;
  /** Switches a mirror on or off on this device; switching it on clears a pause. */
  readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<void>;
  /** Starts reacting: to changes, to finished sync passes, and on a slow heartbeat. */
  readonly start: () => Effect.Effect<void>;
}

type Services =
  | AccountRepo
  | AppleCalendarClient
  | CalendarRepo
  | DeviceSettingsRepo
  | EventRepo
  | GoogleCalendarClient
  | PendingOpRepo
  | SyncEngine
  | SyncStateRepo
  | TaskRepo
  | TokenStore;

/**
 * What the rewrite journal counts: a create or update of a copy with a
 * given content. Deletes are not counted. When a definition change leaves
 * a destination empty, nothing can carry the new revision, and a device
 * still on the old definition writes the excluded copies back until its
 * own creates trip its breaker; the device that is right must keep
 * deleting them, not pause alongside it.
 */
const refName = (ref: MirrorDefinition['destination']): string =>
  ref.kind === 'google' ? (ref.title ?? ref.calendarId) : ref.title;

const journalKey = (op: MirrorOp<unknown>): string | undefined =>
  op.kind === 'create' || op.kind === 'update'
    ? `${op.copy.keyHash}:${op.copy.contentHash}`
    : undefined;

const pruneJournal = (
  journal: MirrorLocal['journal'],
  nowMs: number,
): Record<string, readonly [number, number]> =>
  Object.fromEntries(
    Object.entries(journal ?? {}).filter(([, [, at]]) => nowMs - at < JOURNAL_WINDOW_MS),
  );

const setStatus = (mirrorId: string, status: MirrorStatus, extra: Partial<MirrorLocal> = {}) =>
  updateMirrorLocal(mirrorId, (local) => ({ ...local, ...extra, status }));

const blockedStatus = (
  block: MirrorBlock,
  previous: MirrorStatus | undefined,
  copies = previous?.copies ?? 0,
): MirrorStatus => ({
  copies,
  ...(block.detail === undefined ? {} : { detail: block.detail }),
  ...(previous?.lastRunAt === undefined ? {} : { lastRunAt: previous.lastRunAt }),
  pending: 0,
  reason: block.reason,
  state: WAITING.has(block.reason) ? 'waiting' : 'paused',
});

const make: Effect.Effect<MirrorsShape, never, Reactivity | Services> = Effect.gen(function* () {
  const reactivity = yield* Reactivity;
  const apple: AppleCalendarClientShape = yield* AppleCalendarClient;
  const engine = yield* SyncEngine;
  const google = yield* GoogleCalendarClient;
  const tokenStore = yield* TokenStore;
  const context = yield* Effect.context<Services>();
  // One pass at a time: every trigger calls run(), and two passes over one
  // destination would each plan from the same reads and write twice.
  const gate = Semaphore.makeUnsafe(1);

  // Whether anything a mirror reads changed since its last complete run.
  // The engine reports every finished pass, most of which bring nothing;
  // without this each one would expand months of events again.
  let generation = 0;
  const clean = new Map<
    string,
    { readonly generation: number; readonly rev: number; readonly today: string }
  >();
  // Counted from the moment the service exists, started or not: a run
  // must never take a mirror for clean because nobody was listening.
  const CHANGE_KEYS = [
    ACCOUNTS_KEY,
    CALENDARS_KEY,
    EVENTS_KEY,
    TASKLISTS_KEY,
    TASKS_KEY,
    deviceSettingsKey(MIRRORS_KEY),
  ];
  yield* Effect.forkDetach(
    reactivity.stream(CHANGE_KEYS, Effect.void).pipe(
      Stream.drop(1),
      Stream.runForEach(() => Effect.sync(() => (generation += 1))),
    ),
  );

  const destinationOf = (resolved: ResolvedCalendar): Effect.Effect<MirrorDestination> =>
    resolved.provider === 'google'
      ? googleMirrorDestination(resolved.account, resolved.calendar).pipe(Effect.provide(context))
      : Effect.succeed(appleMirrorDestination(apple, resolved.calendar));

  /** One mirror, one plan. Resolves to whether writes are left for another plan. */
  const runOne = (
    definition: MirrorDefinition,
    local: MirrorLocal,
    options: { readonly deadlineMs: number; readonly force: boolean },
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // Paused by the breaker: only switching it on again clears that.
      if (local.status?.reason === 'rewriteLoop') {
        return false;
      }
      const block = (found: MirrorBlock) =>
        Effect.as(setStatus(definition.id, blockedStatus(found, local.status)), false);

      const resolved = yield* resolveMirror(definition);
      if ('block' in resolved) {
        return yield* block(resolved.block);
      }
      // A newer definition was seen on the copies before: nothing changes
      // that except this device getting the newer definition itself.
      if ((local.newestRev ?? 0) > definition.updatedAt) {
        return yield* block({ reason: 'newerDefinition' });
      }
      const gated = yield* mirrorGate(resolved.value, now);
      if (gated !== undefined) {
        return yield* block(gated);
      }
      const window = mirrorWindow(definition, now);
      const known = clean.get(definition.id);
      if (
        !options.force &&
        known !== undefined &&
        known.generation === generation &&
        known.rev === definition.updatedAt &&
        known.today === window.today &&
        local.status?.state === 'upToDate'
      ) {
        return false;
      }
      const seenAt = generation;

      const destination = yield* destinationOf(resolved.value.destination);
      const items = yield* loadMirrorItems(definition, resolved.value.sources, window, apple);
      const desired = buildMirrorCopies(definition, items, window);
      const actual = yield* destination.read(window.startUtc - DAY_MS, window.endUtc + DAY_MS);
      const tag = mirrorTag(definition.id);
      const plan = planMirror({
        actual,
        desired,
        nowMs: now,
        rev: definition.updatedAt,
        tag,
        window,
      });
      if (plan.foreign > 0) {
        return yield* block({ reason: 'otherMirror' });
      }
      const newestRev = Math.max(plan.newestRev, local.newestRev ?? 0);
      if (newestRev > definition.updatedAt) {
        yield* setStatus(
          definition.id,
          blockedStatus({ reason: 'newerDefinition' }, local.status),
          { newestRev },
        );
        return false;
      }

      // A large share of the copies would go, and not because the
      // definition changed: a source may only look empty (a device still
      // loading iCloud). Hold on; if it still holds later, believe it.
      const large =
        plan.removals > Math.max(LARGE_REMOVAL_MIN, LARGE_REMOVAL_SHARE * plan.present) &&
        plan.newestRev === definition.updatedAt;
      const brakeSince = large ? (local.brakeSince ?? now) : undefined;
      if (large && !options.force && now - (brakeSince ?? now) < LARGE_REMOVAL_WAIT_MS) {
        yield* setStatus(
          definition.id,
          blockedStatus({ reason: 'largeRemoval' }, local.status, plan.present),
          { brakeSince },
        );
        return false;
      }

      const journal = pruneJournal(local.journal, now);
      const ops = plan.ops.slice(0, WRITES_PER_PLAN);
      const rewrites = (op: MirrorOp<unknown>): number => {
        const key = journalKey(op);
        return key === undefined ? 0 : (journal[key]?.[0] ?? 0);
      };
      if (ops.some((op) => rewrites(op) >= REWRITE_LIMIT - 1)) {
        yield* Effect.logWarning('mirror: a copy keeps being rewritten; pausing', {
          mirror: tag,
        });
        yield* setStatus(definition.id, blockedStatus({ reason: 'rewriteLoop' }, local.status), {
          journal,
        });
        return false;
      }

      const result =
        ops.length === 0
          ? { applied: 0, failedIndices: [], processed: 0, rateLimited: false }
          : yield* destination.apply(
              ops,
              { rev: definition.updatedAt, tag, timeZone: definition.timeZone },
              Math.min(options.deadlineMs, now + PLAN_LIFETIME_MS),
            );
      // A copy already carries a newer definition: the writes stopped
      // there (see the Google insert path), and this device stands back.
      if (result.newestRev !== undefined && result.newestRev > definition.updatedAt) {
        yield* setStatus(
          definition.id,
          blockedStatus({ reason: 'newerDefinition' }, local.status),
          {
            journal,
            newestRev: result.newestRev,
          },
        );
        return false;
      }
      const failed = new Set(result.failedIndices);
      ops.slice(0, result.processed).forEach((op, index) => {
        const key = journalKey(op);
        if (key !== undefined && !failed.has(index)) {
          journal[key] = [(journal[key]?.[0] ?? 0) + 1, now];
        }
      });
      const pending = plan.ops.length - result.applied;
      const status: MirrorStatus =
        pending === 0
          ? { copies: desired.length, lastRunAt: now, pending: 0, state: 'upToDate' }
          : { copies: plan.present, lastRunAt: now, pending, state: 'copying' };
      // Counts only: a log line never carries a title.
      if (result.applied > 0) {
        yield* Effect.logInfo('mirror: wrote copies', {
          applied: result.applied,
          mirror: tag,
          pending,
        });
      }
      const { brakeSince: _released, ...rest } = local;
      yield* updateMirrorLocal(definition.id, (current) => ({
        ...rest,
        enabled: current.enabled,
        journal,
        newestRev,
        status,
      }));
      if (pending === 0 && result.applied === 0) {
        clean.set(definition.id, {
          generation: seenAt,
          rev: definition.updatedAt,
          today: window.today,
        });
      }
      // Go again only when this plan made progress, every attempted write
      // landed (a refused one would be refused again) and Google is not
      // asking for a pause.
      return pending > 0 && result.applied > 0 && failed.size === 0 && !result.rateLimited;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning('mirror run failed', { cause: String(cause).slice(0, 300) });
          const failure = String(cause);
          const reason: MirrorReason = failure.includes('AppleCalendar')
            ? 'appleUnavailable'
            : 'error';
          yield* Effect.ignore(setStatus(definition.id, blockedStatus({ reason }, local.status)));
          return false;
        }),
      ),
    );

  const pass = (options: {
    readonly budget?: Duration.Input | undefined;
    readonly force: boolean;
  }) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const deadlineMs =
        options.budget === undefined
          ? Number.MAX_SAFE_INTEGER
          : started + Duration.toMillis(Duration.fromInputUnsafe(options.budget));
      for (const definition of yield* readMirrors) {
        // Plan after plan until the mirror is done or the time is up.
        for (;;) {
          const local = (yield* readMirrorLocals)[definition.id] ?? DEFAULT_MIRROR_LOCAL;
          if (!local.enabled || (yield* Clock.currentTimeMillis) >= deadlineMs) {
            break;
          }
          const more = yield* runOne(definition, local, { deadlineMs, force: options.force });
          if (!more) {
            break;
          }
          yield* Effect.yieldNow;
        }
      }
    });

  const run: MirrorsShape['run'] = (options) =>
    gate
      .withPermits(1)(pass({ budget: options?.budget, force: options?.force ?? false }))
      .pipe(
        Effect.provide(context),
        Effect.catchCause((cause) =>
          Effect.logWarning('mirrors pass failed', { cause: String(cause).slice(0, 300) }),
        ),
      );

  /**
   * Deletes everything a mirror ever wrote into its destination — not
   * just its window: the oldest copy is as old as the mirror, the newest
   * as far ahead as a mirror can reach.
   */
  const removeCopiesOf = (definition: MirrorDefinition) =>
    Effect.gen(function* () {
      const resolved = yield* resolveMirrorDestination(definition);
      if ('block' in resolved) {
        return yield* new MirrorSaveError({
          message: `The copies in ${refName(definition.destination)} could not be removed: that calendar is not available on this device.`,
        });
      }
      const destination = yield* destinationOf(resolved.value);
      const now = yield* Clock.currentTimeMillis;
      const reach = (MIRROR_MAX_MONTHS + 2) * 31 * DAY_MS;
      const tag = mirrorTag(definition.id);
      const stamp = { rev: definition.updatedAt, tag, timeZone: definition.timeZone };
      const google = resolved.value.provider === 'google';
      for (;;) {
        const mine = (yield* destination.read(
          google ? 0 : now - reach,
          google ? Number.MAX_SAFE_INTEGER : now + reach,
        )).filter((actual) => actual.marker.tag === tag);
        if (mine.length === 0) {
          return;
        }
        const batch = mine
          .slice(0, WRITES_PER_PLAN)
          .map((actual): MirrorOp<unknown> => ({ actual, kind: 'delete' }));
        const result = yield* destination.apply(batch, stamp, Number.MAX_SAFE_INTEGER);
        if (result.applied === 0) {
          return yield* new MirrorSaveError({
            message: 'The copies could not be removed right now. Try again in a moment.',
          });
        }
      }
    });

  const views = Effect.gen(function* () {
    const locals = yield* readMirrorLocals;
    return (yield* readMirrors).map((definition): MirrorView => ({
      definition,
      enabled: locals[definition.id]?.enabled ?? false,
      status: mirrorStatusOf(locals[definition.id]),
    }));
  });

  const kick = Effect.forkDetach(run());

  const service: MirrorsShape = {
    createCalendar: (target) =>
      Effect.gen(function* () {
        if (target.kind === 'apple') {
          const created = yield* apple.createCalendar({ title: target.title });
          // The calendar list is mirrored into SQLite; the next line of
          // the editor picks the row, so it has to be there.
          yield* engine.syncAll();
          return {
            kind: 'apple' as const,
            source: created.sourceTitle || APPLE_DEFAULT_SOURCE,
            title: created.title,
          };
        }
        const account = yield* (yield* AccountRepo).get(target.accountId);
        if (account === undefined || account.provider !== 'google' || account.status !== 'ok') {
          return yield* new MirrorCalendarError({
            message: 'Sign in to this Google account first.',
            reason: 'needsSignIn',
          });
        }
        const tokens = yield* tokenStore.get(account.id);
        if (tokens !== null && !grantsCalendarCreation(tokens.scopes)) {
          return yield* new MirrorCalendarError({
            message: `${account.email} was signed in before Solunivo could create calendars. Sign in again to allow it.`,
            reason: 'needsSignIn',
          });
        }
        const created = yield* google
          .insertCalendar({ accountId: account.id, summary: target.title })
          .pipe(
            Effect.catchTag('InsufficientScopeError', () =>
              Effect.fail(
                new MirrorCalendarError({
                  message: `${account.email} was signed in before Solunivo could create calendars. Sign in again to allow it.`,
                  reason: 'needsSignIn',
                }),
              ),
            ),
          );
        yield* engine.syncAll();
        return {
          calendarId: created.id,
          email: account.email,
          kind: 'google' as const,
          title: created.summary ?? target.title,
        };
      }).pipe(
        Effect.provide(context),
        Effect.catchIf(
          (error): error is Exclude<typeof error, MirrorCalendarError> =>
            !(error instanceof MirrorCalendarError),
          (error) =>
            Effect.fail(
              new MirrorCalendarError({
                message:
                  'message' in error && typeof error.message === 'string'
                    ? error.message
                    : error._tag,
                reason: 'failed',
              }),
            ),
        ),
      ),

    list: () =>
      views.pipe(
        Effect.provide(context),
        Effect.orElseSucceed(() => []),
      ),

    preview: (definition) =>
      Effect.gen(function* () {
        const resolved = yield* resolveMirror(definition);
        if ('block' in resolved) {
          return { blocked: resolved.block, copies: 0, otherEvents: 0, samples: [] };
        }
        const now = yield* Clock.currentTimeMillis;
        const window = mirrorWindow(definition, now);
        const destination = yield* destinationOf(resolved.value.destination);
        const items = yield* loadMirrorItems(definition, resolved.value.sources, window, apple);
        const desired = buildMirrorCopies(definition, items, window);
        const upcoming = desired.filter((copy) => copy.endUtc >= now);
        return {
          copies: desired.length,
          otherEvents: yield* destination.countOrdinary(window.startUtc, window.endUtc),
          samples: (upcoming.length > 0 ? upcoming : desired).slice(0, 3).map((copy) => ({
            allDay: copy.allDay,
            ...(copy.description === undefined ? {} : { description: copy.description }),
            ...(copy.endDate === undefined ? {} : { endDate: copy.endDate }),
            endUtc: copy.endUtc,
            ...(copy.location === undefined ? {} : { location: copy.location }),
            ...(copy.startDate === undefined ? {} : { startDate: copy.startDate }),
            startUtc: copy.startUtc,
            title: copy.title,
          })),
        };
      }).pipe(
        Effect.provide(context),
        Effect.catchCause((): Effect.Effect<MirrorPreview> =>
          Effect.succeed({
            blocked: { reason: 'error' },
            copies: 0,
            otherEvents: 0,
            samples: [],
          }),
        ),
      ),

    remove: (id, removeCopies) =>
      gate
        .withPermits(1)(
          Effect.gen(function* () {
            const definition = (yield* readMirrors).find((mirror) => mirror.id === id);
            if (definition !== undefined && removeCopies) {
              yield* removeCopiesOf(definition);
            }
            yield* removeMirror(id);
            clean.delete(id);
          }),
        )
        .pipe(
          Effect.provide(context),
          Effect.catchIf(
            (error): error is Exclude<typeof error, MirrorSaveError> =>
              !(error instanceof MirrorSaveError),
            () =>
              Effect.fail(
                new MirrorSaveError({
                  message: 'The copies could not be removed right now. Try again in a moment.',
                }),
              ),
          ),
        ),

    run,

    save: (definition) =>
      Effect.gen(function* () {
        // A mirror that moves to another calendar takes its copies out of
        // the old one first; nothing would ever reach them there again.
        const previous = (yield* readMirrors).find((mirror) => mirror.id === definition.id);
        if (
          previous !== undefined &&
          mirrorRefKey(previous.destination) !== mirrorRefKey(definition.destination)
        ) {
          yield* gate.withPermits(1)(removeCopiesOf(previous));
        }
        const saved = yield* saveMirror(definition, yield* Clock.currentTimeMillis);
        // A mirror made here runs here; one that arrives by import stays
        // off until it is switched on.
        const local = yield* updateMirrorLocal(saved.id, (current) =>
          current === DEFAULT_MIRROR_LOCAL ? { enabled: true } : current,
        );
        yield* kick;
        return { definition: saved, enabled: local.enabled, status: mirrorStatusOf(local) };
      }).pipe(
        Effect.provide(context),
        Effect.catchIf(
          (error): error is Exclude<typeof error, MirrorSaveError> =>
            !(error instanceof MirrorSaveError),
          (error) => Effect.fail(new MirrorSaveError({ message: String(error) })),
        ),
      ),

    setEnabled: (id, enabled) =>
      Effect.gen(function* () {
        // Switching on starts clean: no pause, no journal of old rewrites.
        yield* updateMirrorLocal(id, (local) =>
          enabled ? { enabled, newestRev: local.newestRev } : { ...local, enabled },
        );
        clean.delete(id);
        if (enabled) {
          yield* kick;
        }
      }).pipe(Effect.provide(context), Effect.ignore),

    start: () =>
      Effect.gen(function* () {
        // Something a mirror reads changed: sources, calendars, accounts, a definition.
        const changed = reactivity.stream(CHANGE_KEYS, Effect.void).pipe(
          Stream.drop(1),
          Stream.debounce(CHANGE_DEBOUNCE),
          Stream.runForEach(() => run()),
        );
        // A sync pass finished: nothing may have changed, but a mirror
        // that was waiting for fresh data can go now.
        const synced = reactivity.stream([SYNC_STATE_KEY], Effect.void).pipe(
          Stream.drop(1),
          Stream.debounce(CHANGE_DEBOUNCE),
          Stream.runForEach(() => run()),
        );
        // The heartbeat covers what no key reports — above all the day
        // turning over in a mirror's zone, which moves every open task.
        const heartbeat = Effect.forever(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const zones = (yield* readMirrors).map((mirror) => mirror.timeZone);
            const untilMidnight = Math.min(
              HEARTBEAT_MS,
              ...zones.map((zone) => msUntilNextMidnight(zone, now) + 2000),
            );
            yield* Effect.sleep(Duration.millis(untilMidnight));
            generation += 1;
            yield* run();
          }).pipe(
            Effect.provide(context),
            Effect.catchCause(() => Effect.sleep(Duration.millis(HEARTBEAT_MS))),
          ),
        );
        yield* Effect.forkDetach(changed);
        yield* Effect.forkDetach(synced);
        yield* Effect.forkDetach(heartbeat);
        yield* kick;
      }),
  };
  return service;
});

export class Mirrors extends Context.Service<Mirrors, MirrorsShape>()('sync/Mirrors') {
  static readonly layer: Layer.Layer<Mirrors, never, Reactivity | Services> =
    Layer.effect(Mirrors)(make);
}
