import { EventRecord, PendingOp, type EventDraft } from '@calendar/core';
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

/** Recurring series editing is out of scope for v1. */
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

export interface EventMutationsShape {
  readonly createEvent: (draft: EventDraft) => Effect.Effect<EventRecord, SqlError>;
  readonly deleteEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly eventId: string;
  }) => Effect.Effect<void, EventNotFoundError | RecurringEditUnsupportedError | SqlError>;
  /** Drains due pending ops (serialized); safe to call concurrently. */
  readonly processPendingOps: () => Effect.Effect<void>;
  readonly updateEvent: (
    params: UpdateEventParams,
  ) => Effect.Effect<void, EventNotFoundError | RecurringEditUnsupportedError | SqlError>;
}

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
