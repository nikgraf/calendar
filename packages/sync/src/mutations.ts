import {
  EventRecord,
  googleInstanceId,
  PendingOp,
  remainingRecurrence,
  truncateRecurrence,
  type EventDraft,
  type RecurringScope,
} from '@calendar/core';
import { EventRepo, PendingOpRepo } from '@calendar/db';
import {
  generateEventId,
  GoogleCalendarClient,
  mapGcalEvent,
  toGcalEventInput,
} from '@calendar/google';
import { Clock, Context, Data, Effect, Layer, Semaphore } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';

export class EventNotFoundError extends Data.TaggedError('EventNotFoundError')<{
  readonly eventId: string;
}> {}

/**
 * Raised when a plain edit targets a recurring master/override (those go
 * through updateRecurring/deleteRecurring) or a recurring edit targets a
 * non-recurring event.
 */
export class RecurringEditUnsupportedError extends Data.TaggedError(
  'RecurringEditUnsupportedError',
)<{ readonly eventId: string }> {}

export interface UpdateEventParams {
  readonly accountId: string;
  readonly calendarId: string;
  readonly changes: {
    readonly description?: string | undefined;
    readonly endDate?: string | undefined;
    readonly endUtc?: number | undefined;
    readonly isAllDay?: boolean | undefined;
    readonly location?: string | undefined;
    readonly startDate?: string | undefined;
    readonly startUtc?: number | undefined;
    readonly title?: string | undefined;
  };
  readonly eventId: string;
}

/** Identifies one occurrence of a recurring series and the edit's reach. */
export interface RecurringTargetParams {
  readonly accountId: string;
  readonly calendarId: string;
  readonly masterId: string;
  readonly originalStartUtc: number;
  readonly scope: RecurringScope;
}

export interface UpdateRecurringParams extends RecurringTargetParams {
  readonly changes: UpdateEventParams['changes'];
}

type RecurringEditError = EventNotFoundError | RecurringEditUnsupportedError | SqlError;

export interface EventMutationsShape {
  readonly createEvent: (draft: EventDraft) => Effect.Effect<EventRecord, SqlError>;
  readonly deleteEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly eventId: string;
  }) => Effect.Effect<void, RecurringEditError>;
  readonly deleteRecurring: (
    params: RecurringTargetParams,
  ) => Effect.Effect<void, RecurringEditError>;
  /** Drains due pending ops (serialized); safe to call concurrently. */
  readonly processPendingOps: () => Effect.Effect<void>;
  readonly updateEvent: (params: UpdateEventParams) => Effect.Effect<void, RecurringEditError>;
  readonly updateRecurring: (
    params: UpdateRecurringParams,
  ) => Effect.Effect<void, RecurringEditError>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

/** Backoff for transient op failures: 30s · 2^attempts, capped at 30min. */
const retryDelayMs = (attempts: number): number => Math.min(30_000 * 2 ** attempts, 30 * 60 * 1000);

const make: Effect.Effect<
  EventMutationsShape,
  never,
  EventRepo | GoogleCalendarClient | PendingOpRepo
> = Effect.gen(function* () {
  const eventRepo = yield* EventRepo;
  const pendingOpRepo = yield* PendingOpRepo;
  const client = yield* GoogleCalendarClient;
  const gate = Semaphore.makeUnsafe(1);

  const opsForEvent = (calendarId: string, eventId: string) =>
    Effect.map(pendingOpRepo.listAll(), (ops) =>
      ops.filter((op) => op.calendarId === calendarId && op.eventId === eventId),
    );

  const enqueueAndKick = (op: PendingOp) =>
    Effect.gen(function* () {
      yield* pendingOpRepo.enqueue(op);
      yield* Effect.forkDetach(processPendingOps());
    });

  const loadMaster = (accountId: string, calendarId: string, masterId: string) =>
    Effect.gen(function* () {
      const master = yield* eventRepo.getById(accountId, calendarId, masterId);
      if (!master) {
        return yield* Effect.fail(new EventNotFoundError({ eventId: masterId }));
      }
      const recurrence = master.recurrence;
      if (!recurrence || recurrence.length === 0) {
        return yield* Effect.fail(new RecurringEditUnsupportedError({ eventId: masterId }));
      }
      return { master, recurrence };
    });

  /** The occurrence as it would render, keyed by its Google instance id. */
  const projectInstance = (master: EventRecord, originalStartUtc: number, now: number) => {
    const durationDays =
      master.isAllDay && master.startDate && master.endDate
        ? Math.round((Date.parse(master.endDate) - Date.parse(master.startDate)) / DAY_MS)
        : 0;
    return new EventRecord({
      ...master,
      endDate: master.isAllDay ? isoDate(originalStartUtc + durationDays * DAY_MS) : undefined,
      endUtc:
        originalStartUtc +
        (master.isAllDay ? durationDays * DAY_MS : master.endUtc - master.startUtc),
      etag: null,
      id: googleInstanceId(master.id, originalStartUtc, master.isAllDay),
      originalStartUtc,
      recurrence: undefined,
      recurringEventId: master.id,
      startDate: master.isAllDay ? isoDate(originalStartUtc) : undefined,
      startUtc: originalStartUtc,
      syncedAt: 0,
      syncStatus: 'pending',
      updatedAt: now,
    });
  };

  /** Drops override rows at/after the split and cancels them remotely. */
  const dropOverridesFrom = (
    accountId: string,
    calendarId: string,
    masterId: string,
    fromOriginalStartUtc: number,
    now: number,
  ) =>
    Effect.gen(function* () {
      const overrides = yield* eventRepo.listOverrides(accountId, calendarId, masterId);
      for (const override of overrides) {
        if ((override.originalStartUtc ?? override.startUtc) < fromOriginalStartUtc) {
          continue;
        }
        yield* pendingOpRepo.removeForEvent(calendarId, override.id);
        yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            baseEtag: override.etag ?? undefined,
            calendarId,
            createdAt: now,
            eventId: override.id,
            id: generateEventId(),
            kind: 'delete',
            nextAttemptAt: 0,
          }),
        );
      }
    });

  const applyOp = (op: PendingOp): Effect.Effect<'done' | 'retry', never> =>
    Effect.gen(function* () {
      switch (op.kind) {
        case 'create': {
          if (!op.payload) {
            return 'done' as const;
          }
          const response = yield* client.insertEvent({
            accountId: op.accountId,
            calendarId: op.calendarId,
            event: toGcalEventInput(op.payload),
          });
          const synced = mapGcalEvent(response, {
            accountId: op.accountId,
            calendarId: op.calendarId,
            defaultTimeZone: op.payload.startTimeZone ?? 'UTC',
            syncedAt: yield* Clock.currentTimeMillis,
          });
          if (synced) {
            yield* eventRepo.upsertMany([synced]);
          }
          return 'done' as const;
        }
        case 'delete': {
          yield* client.deleteEvent({
            accountId: op.accountId,
            baseEtag: op.baseEtag,
            calendarId: op.calendarId,
            eventId: op.eventId,
          });
          return 'done' as const;
        }
        case 'update': {
          if (!op.payload) {
            return 'done' as const;
          }
          const response = yield* client.patchEvent({
            accountId: op.accountId,
            baseEtag: op.baseEtag,
            calendarId: op.calendarId,
            event: toGcalEventInput(op.payload),
            eventId: op.eventId,
          });
          const synced = mapGcalEvent(response, {
            accountId: op.accountId,
            calendarId: op.calendarId,
            defaultTimeZone: op.payload.startTimeZone ?? 'UTC',
            syncedAt: yield* Clock.currentTimeMillis,
          });
          if (synced) {
            yield* eventRepo.upsertMany([synced]);
          }
          return 'done' as const;
        }
      }
    }).pipe(
      Effect.catchTags({
        // The local optimistic copy stays until the next sync pass replaces
        // it with the server's version: server wins in v1.
        ConflictError: () => Effect.succeed('done' as const),
        GoogleApiError: (error) =>
          // 409 on insert = the idempotent create already landed.
          error.status === 409 ? Effect.succeed('done' as const) : Effect.succeed('retry' as const),
        NotFoundError: () =>
          Effect.gen(function* () {
            // Deleted remotely — drop the local copy too.
            yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
            return 'done' as const;
          }),
        SyncTokenExpiredError: () => Effect.succeed('done' as const),
      }),
      Effect.catchCause(() => Effect.succeed('retry' as const)),
    );

  const processPendingOps = (): Effect.Effect<void> =>
    gate
      .withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const due = yield* pendingOpRepo.listDue(now);
          for (const op of due) {
            const outcome = yield* applyOp(op);
            if (outcome === 'done') {
              yield* pendingOpRepo.remove(op.id);
            } else {
              yield* pendingOpRepo.markFailed(
                op.id,
                op.attempts + 1,
                now + retryDelayMs(op.attempts),
                'transient failure',
              );
            }
          }
        }),
      )
      .pipe(Effect.catchCause(() => Effect.void));

  const shape: EventMutationsShape = {
    createEvent: (draft) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const record = new EventRecord({
          accountId: draft.accountId,
          calendarId: draft.calendarId,
          description: draft.description,
          endDate: draft.endDate,
          endUtc: draft.endUtc,
          etag: null,
          id: generateEventId(),
          isAllDay: draft.isAllDay,
          location: draft.location,
          startDate: draft.startDate,
          startTimeZone: draft.startTimeZone,
          startUtc: draft.startUtc,
          status: 'confirmed',
          syncedAt: 0,
          syncStatus: 'pending',
          title: draft.title,
          updatedAt: now,
        });
        yield* eventRepo.upsertMany([record]);
        yield* enqueueAndKick(
          new PendingOp({
            accountId: draft.accountId,
            attempts: 0,
            calendarId: draft.calendarId,
            createdAt: now,
            eventId: record.id,
            id: generateEventId(),
            kind: 'create',
            nextAttemptAt: 0,
            payload: record,
          }),
        );
        return record;
      }),

    deleteEvent: ({ accountId, calendarId, eventId }) =>
      Effect.gen(function* () {
        const existing = yield* eventRepo.getById(accountId, calendarId, eventId);
        if (!existing) {
          return yield* Effect.fail(new EventNotFoundError({ eventId }));
        }
        if (existing.recurringEventId || existing.recurrence) {
          return yield* Effect.fail(new RecurringEditUnsupportedError({ eventId }));
        }
        const queued = yield* opsForEvent(calendarId, eventId);
        yield* pendingOpRepo.removeForEvent(calendarId, eventId);
        yield* eventRepo.deleteEvent(accountId, calendarId, eventId);

        const neverSynced = queued.some((op) => op.kind === 'create');
        if (!neverSynced) {
          const now = yield* Clock.currentTimeMillis;
          yield* enqueueAndKick(
            new PendingOp({
              accountId,
              attempts: 0,
              baseEtag: existing.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId,
              id: generateEventId(),
              kind: 'delete',
              nextAttemptAt: 0,
            }),
          );
        }
      }),

    deleteRecurring: ({ accountId, calendarId, masterId, originalStartUtc, scope }) =>
      Effect.gen(function* () {
        const { master, recurrence } = yield* loadMaster(accountId, calendarId, masterId);
        const now = yield* Clock.currentTimeMillis;

        if (scope === 'instance') {
          // A cancelled override shadows the generated occurrence locally;
          // deleting the instance id cancels it server-side.
          const instanceId = googleInstanceId(masterId, originalStartUtc, master.isAllDay);
          const existing = yield* eventRepo.getById(accountId, calendarId, instanceId);
          const tombstone = new EventRecord({
            ...(existing ?? projectInstance(master, originalStartUtc, now)),
            status: 'cancelled',
            syncStatus: 'pending',
            updatedAt: now,
          });
          yield* eventRepo.upsertMany([tombstone]);
          yield* pendingOpRepo.removeForEvent(calendarId, instanceId);
          yield* enqueueAndKick(
            new PendingOp({
              accountId,
              attempts: 0,
              baseEtag: existing?.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId: instanceId,
              id: generateEventId(),
              kind: 'delete',
              nextAttemptAt: 0,
            }),
          );
          return;
        }

        if (scope === 'series' || originalStartUtc <= master.startUtc) {
          // Deleting the master cascades to its exceptions server-side.
          const overrides = yield* eventRepo.listOverrides(accountId, calendarId, masterId);
          for (const override of overrides) {
            yield* pendingOpRepo.removeForEvent(calendarId, override.id);
            yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
          }
          yield* pendingOpRepo.removeForEvent(calendarId, masterId);
          yield* eventRepo.deleteEvent(accountId, calendarId, masterId);
          yield* enqueueAndKick(
            new PendingOp({
              accountId,
              attempts: 0,
              baseEtag: master.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId: masterId,
              id: generateEventId(),
              kind: 'delete',
              nextAttemptAt: 0,
            }),
          );
          return;
        }

        // this-and-following: end the series just before the occurrence.
        const truncated = new EventRecord({
          ...master,
          recurrence: truncateRecurrence(recurrence, originalStartUtc, master.isAllDay),
          syncStatus: 'pending',
          updatedAt: now,
        });
        yield* eventRepo.upsertMany([truncated]);
        yield* pendingOpRepo.removeForEvent(calendarId, masterId);
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            baseEtag: master.etag ?? undefined,
            calendarId,
            createdAt: now,
            eventId: masterId,
            id: generateEventId(),
            kind: 'update',
            nextAttemptAt: 0,
            payload: truncated,
          }),
        );
        yield* dropOverridesFrom(accountId, calendarId, masterId, originalStartUtc, now);
      }),

    processPendingOps,

    updateEvent: ({ accountId, calendarId, changes, eventId }) =>
      Effect.gen(function* () {
        const existing = yield* eventRepo.getById(accountId, calendarId, eventId);
        if (!existing) {
          return yield* Effect.fail(new EventNotFoundError({ eventId }));
        }
        if (existing.recurringEventId || existing.recurrence) {
          return yield* Effect.fail(new RecurringEditUnsupportedError({ eventId }));
        }
        const now = yield* Clock.currentTimeMillis;
        const defined = Object.fromEntries(
          Object.entries(changes).filter(([, value]) => value !== undefined),
        );
        const merged = new EventRecord({
          ...existing,
          ...defined,
          syncStatus: 'pending',
          updatedAt: now,
        });
        yield* eventRepo.upsertMany([merged]);

        // Coalesce: a queued create absorbs the change; otherwise a fresh
        // update op replaces any queued update.
        const queued = yield* opsForEvent(calendarId, eventId);
        yield* pendingOpRepo.removeForEvent(calendarId, eventId);
        const hasCreate = queued.some((op) => op.kind === 'create');
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            baseEtag: hasCreate ? undefined : (existing.etag ?? undefined),
            calendarId,
            createdAt: now,
            eventId,
            id: generateEventId(),
            kind: hasCreate ? 'create' : 'update',
            nextAttemptAt: 0,
            payload: merged,
          }),
        );
      }),

    updateRecurring: ({ accountId, calendarId, changes, masterId, originalStartUtc, scope }) =>
      Effect.gen(function* () {
        const { master, recurrence } = yield* loadMaster(accountId, calendarId, masterId);
        const now = yield* Clock.currentTimeMillis;
        const defined = Object.fromEntries(
          Object.entries(changes).filter(([, value]) => value !== undefined),
        );

        if (scope === 'instance') {
          // Materialize (or update) the exception under its instance id; the
          // patch on that id creates the exception server-side.
          const instanceId = googleInstanceId(masterId, originalStartUtc, master.isAllDay);
          const existing = yield* eventRepo.getById(accountId, calendarId, instanceId);
          const merged = new EventRecord({
            ...(existing ?? projectInstance(master, originalStartUtc, now)),
            ...defined,
            originalStartUtc,
            recurrence: undefined,
            recurringEventId: masterId,
            syncStatus: 'pending',
            updatedAt: now,
          });
          yield* eventRepo.upsertMany([merged]);
          yield* pendingOpRepo.removeForEvent(calendarId, instanceId);
          yield* enqueueAndKick(
            new PendingOp({
              accountId,
              attempts: 0,
              baseEtag: existing?.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId: instanceId,
              id: generateEventId(),
              kind: 'update',
              nextAttemptAt: 0,
              payload: merged,
            }),
          );
          return;
        }

        const duration =
          changes.startUtc !== undefined && changes.endUtc !== undefined
            ? changes.endUtc - changes.startUtc
            : master.endUtc - master.startUtc;

        if (scope === 'series' || originalStartUtc <= master.startUtc) {
          // Time edits shift the master (and thus every occurrence) by the
          // occurrence's delta; all-day masters only take non-time fields.
          const delta =
            !master.isAllDay && changes.startUtc !== undefined
              ? changes.startUtc - originalStartUtc
              : 0;
          const startUtc = master.startUtc + delta;
          const merged = new EventRecord({
            ...master,
            description: changes.description ?? master.description,
            endUtc: master.isAllDay ? master.endUtc : startUtc + duration,
            location: changes.location ?? master.location,
            startUtc: master.isAllDay ? master.startUtc : startUtc,
            syncStatus: 'pending',
            title: changes.title ?? master.title,
            updatedAt: now,
          });
          yield* eventRepo.upsertMany([merged]);
          yield* pendingOpRepo.removeForEvent(calendarId, masterId);
          yield* enqueueAndKick(
            new PendingOp({
              accountId,
              attempts: 0,
              baseEtag: master.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId: masterId,
              id: generateEventId(),
              kind: 'update',
              nextAttemptAt: 0,
              payload: merged,
            }),
          );
          return;
        }

        // this-and-following: truncate the old series before the occurrence
        // and start a new master at the (possibly re-timed) occurrence.
        const newRecurrence = remainingRecurrence(
          {
            endDate: master.endDate,
            endUtc: master.endUtc,
            id: master.id,
            isAllDay: master.isAllDay,
            recurrence,
            startDate: master.startDate,
            startTimeZone: master.startTimeZone ?? 'UTC',
            startUtc: master.startUtc,
          },
          originalStartUtc,
        );
        const truncated = new EventRecord({
          ...master,
          recurrence: truncateRecurrence(recurrence, originalStartUtc, master.isAllDay),
          syncStatus: 'pending',
          updatedAt: now,
        });
        yield* eventRepo.upsertMany([truncated]);
        yield* pendingOpRepo.removeForEvent(calendarId, masterId);
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            baseEtag: master.etag ?? undefined,
            calendarId,
            createdAt: now,
            eventId: masterId,
            id: generateEventId(),
            kind: 'update',
            nextAttemptAt: 0,
            payload: truncated,
          }),
        );
        yield* dropOverridesFrom(accountId, calendarId, masterId, originalStartUtc, now);

        const projected = projectInstance(master, originalStartUtc, now);
        const startUtc =
          !master.isAllDay && changes.startUtc !== undefined
            ? changes.startUtc
            : projected.startUtc;
        const newMaster = new EventRecord({
          ...projected,
          ...defined,
          endUtc: master.isAllDay ? projected.endUtc : startUtc + duration,
          etag: null,
          id: generateEventId(),
          originalStartUtc: undefined,
          recurrence: newRecurrence,
          recurringEventId: undefined,
          startUtc,
          syncedAt: 0,
        });
        yield* eventRepo.upsertMany([newMaster]);
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId,
            createdAt: now,
            eventId: newMaster.id,
            id: generateEventId(),
            kind: 'create',
            nextAttemptAt: 0,
            payload: newMaster,
          }),
        );
      }),
  };

  return shape;
});

export class EventMutations extends Context.Service<EventMutations, EventMutationsShape>()(
  'sync/EventMutations',
) {
  static readonly layer: Layer.Layer<
    EventMutations,
    never,
    EventRepo | GoogleCalendarClient | PendingOpRepo
  > = Layer.effect(EventMutations)(make);
}
