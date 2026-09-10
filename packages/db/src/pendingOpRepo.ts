import { type PendingOp } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { OPS_KEY } from './keys.ts';
import { pendingOpFromRow, type PendingOpRow } from './rows.ts';
import { eventPayloadJson } from './repoShared.ts';

export interface PendingOpRepoShape {
  readonly enqueue: (op: PendingOp) => Effect.Effect<void, SqlError>;
  readonly getById: (opId: string) => Effect.Effect<PendingOp | undefined, SqlError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  readonly listDue: (now: number) => Effect.Effect<ReadonlyArray<PendingOp>, SqlError>;
  /** Persists the pre-network stamp for non-idempotent calls. */
  readonly markDispatched: (opId: string, at: number) => Effect.Effect<void, SqlError>;
  readonly markFailed: (
    opId: string,
    attempts: number,
    nextAttemptAt: number,
    lastError: string,
  ) => Effect.Effect<void, SqlError>;
  readonly remove: (opId: string) => Effect.Effect<void, SqlError>;
  readonly removeForEvent: (calendarId: string, eventId: string) => Effect.Effect<void, SqlError>;
  /** Re-keys queued ops after a server-assigned id replaces a temp id. */
  readonly rewriteEventId: (
    accountId: string,
    calendarId: string,
    oldEventId: string,
    newEventId: string,
  ) => Effect.Effect<void, SqlError>;
}

/** Ops one drain pass takes on; a larger backlog continues on the next kick. */
const DRAIN_PAGE_SIZE = 200;

/** Rows of an unknown op kind are skipped: nothing could apply them. */
const decodedOps = (row: PendingOpRow): Array<PendingOp> => {
  const op = pendingOpFromRow(row);
  return op ? [op] : [];
};

const makePendingOpRepo: Effect.Effect<PendingOpRepoShape, never, Reactivity | SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    const invalidating = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([OPS_KEY], effect);

    return {
      enqueue: (op) =>
        invalidating(
          Effect.asVoid(sql`
          INSERT INTO pending_ops (id, account_id, calendar_id, kind, event_id,
                                   payload, base_etag, attempts, next_attempt_at,
                                   last_error, created_at, color_hex,
                                   task_list_id, task_status,
                                   task_title, task_notes, task_due, dispatched_at,
                                   attendees_changed)
          VALUES (${op.id}, ${op.accountId}, ${op.calendarId}, ${op.kind},
                  ${op.eventId},
                  ${op.payload ? JSON.stringify(eventPayloadJson(op.payload)) : null},
                  ${op.baseEtag ?? null}, ${op.attempts}, ${op.nextAttemptAt},
                  ${op.lastError ?? null}, ${op.createdAt}, ${op.colorHex ?? null},
                  ${op.taskListId ?? null}, ${op.taskStatus ?? null},
                  ${op.taskTitle ?? null}, ${op.taskNotes ?? null}, ${op.taskDue ?? null},
                  ${op.dispatchedAt ?? null}, ${op.attendeesChanged ? 1 : 0})
        `),
        ),
      getById: (opId) =>
        Effect.map(sql<PendingOpRow>`SELECT * FROM pending_ops WHERE id = ${opId}`, (rows) =>
          rows[0] ? pendingOpFromRow(rows[0]) : undefined,
        ),
      listAll: () =>
        Effect.map(sql<PendingOpRow>`SELECT * FROM pending_ops ORDER BY created_at`, (rows) =>
          rows.flatMap(decodedOps),
        ),
      // Bounded: one drain handles a page; the next kick takes the rest.
      listDue: (now) =>
        Effect.map(
          sql<PendingOpRow>`SELECT * FROM pending_ops
            WHERE next_attempt_at <= ${now} ORDER BY created_at LIMIT ${DRAIN_PAGE_SIZE}`,
          (rows) => rows.flatMap(decodedOps),
        ),
      markDispatched: (opId, at) =>
        invalidating(
          Effect.asVoid(sql`UPDATE pending_ops SET dispatched_at = ${at} WHERE id = ${opId}`),
        ),
      markFailed: (opId, attempts, nextAttemptAt, lastError) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET attempts = ${attempts},
              next_attempt_at = ${nextAttemptAt}, last_error = ${lastError}
              WHERE id = ${opId}`,
          ),
        ),
      remove: (opId) =>
        invalidating(Effect.asVoid(sql`DELETE FROM pending_ops WHERE id = ${opId}`)),
      // RSVP ops survive content-edit coalescing; stray ones resolve as
      // no-ops through the NotFound path after a delete.
      removeForEvent: (calendarId, eventId) =>
        invalidating(
          Effect.asVoid(
            sql`DELETE FROM pending_ops WHERE calendar_id = ${calendarId}
              AND event_id = ${eventId} AND kind != 'rsvp'`,
          ),
        ),
      rewriteEventId: (accountId, calendarId, oldEventId, newEventId) =>
        invalidating(
          Effect.asVoid(
            sql`UPDATE pending_ops SET event_id = ${newEventId}
              WHERE account_id = ${accountId} AND calendar_id = ${calendarId}
                AND event_id = ${oldEventId}`,
          ),
        ),
    };
  });

export class PendingOpRepo extends Context.Service<PendingOpRepo, PendingOpRepoShape>()(
  'db/PendingOpRepo',
) {
  static readonly layer: Layer.Layer<PendingOpRepo, never, Reactivity | SqlClient> =
    Layer.effect(PendingOpRepo)(makePendingOpRepo);
}
